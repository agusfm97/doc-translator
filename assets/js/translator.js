// ============================================================
// Mesin terjemahan — memakai endpoint publik Google Translate.
// Tidak butuh API key. Semua permintaan berjalan dari browser.
// ============================================================

const GTX_URL = "https://translate.googleapis.com/translate_a/single";

const MAX_ITEMS = 30;
const MAX_CHARS = 3500;
const MAX_CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;

export class TranslationError extends Error {
  constructor(message, { rateLimited = false } = {}) {
    super(message);
    this.name = "TranslationError";
    this.rateLimited = rateLimited;
  }
}

export class AbortedError extends Error {
  constructor() {
    super("Dibatalkan");
    this.name = "AbortedError";
  }
}

const hasLetter = /\p{L}/u;

/** Teks yang tidak perlu dikirim ke mesin penerjemah. */
export function isTranslatable(text) {
  if (!text) return false;
  const core = text.trim();
  if (!core) return false;
  if (!hasLetter.test(core)) return false;
  // URL, email, angka dengan satuan, kode pendek
  if (/^(https?:\/\/|www\.)\S+$/i.test(core)) return false;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(core)) return false;
  return true;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AbortedError());
      },
      { once: true }
    );
  });
}

/** Pisahkan teks panjang pada batas kalimat / baris. */
function splitLong(text, max = 1800) {
  if (text.length <= max) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    const window = rest.slice(0, max);
    const match = window.match(/[\s\S]*[.!?…;:]\s/);
    if (match && match[0].length > max * 0.4) cut = match[0].length;
    else {
      const nl = window.lastIndexOf("\n");
      if (nl > max * 0.4) cut = nl + 1;
      else {
        const sp = window.lastIndexOf(" ");
        cut = sp > max * 0.4 ? sp + 1 : max;
      }
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

function parseGtx(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return "";
  return payload[0]
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
    .join("");
}

export class Translator {
  constructor({ source = "auto", target = "id", signal } = {}) {
    this.source = source;
    this.target = target;
    this.signal = signal;
    this.cache = new Map();
    this.requests = 0;
    this.chars = 0;
  }

  checkAborted() {
    if (this.signal?.aborted) throw new AbortedError();
  }

  async postForm(params) {
    const res = await fetch(GTX_URL, {
      method: "POST",
      body: params,
      signal: this.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
    });
    this.requests += 1;
    if (res.status === 429) {
      throw new TranslationError("Batas permintaan tercapai (429).", { rateLimited: true });
    }
    if (!res.ok) throw new TranslationError(`HTTP ${res.status}`);
    const payload = await res.json().catch(() => null);
    if (!payload) throw new TranslationError("Respons tidak dapat dibaca.");
    return payload;
  }

  /**
   * Kirim beberapa teks dalam satu permintaan. Google mempertahankan
   * karakter baris baru, sehingga hasilnya bisa dipetakan kembali per teks.
   */
  async requestBatch(texts) {
    const params = new URLSearchParams({
      client: "gtx",
      sl: this.source,
      tl: this.target,
      dt: "t",
      q: texts.join("\n"),
    });
    const payload = await this.postForm(params);
    const joined = parseGtx(payload);
    if (!joined) throw new TranslationError("Respons kosong.");
    if (texts.length === 1) return [joined];

    const parts = joined.split("\n");
    if (parts.length === texts.length + 1 && !parts[parts.length - 1].trim()) parts.pop();
    if (parts.length !== texts.length) {
      throw new TranslationError("Jumlah baris hasil tidak sesuai.");
    }
    return parts;
  }

  async requestGtx(text) {
    const params = new URLSearchParams({
      client: "gtx",
      sl: this.source,
      tl: this.target,
      dt: "t",
      q: text,
    });
    const payload = await this.postForm(params);
    const out = parseGtx(payload);
    if (!out) throw new TranslationError("Respons kosong.");
    return out;
  }

  async translateBatch(texts) {
    this.checkAborted();
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestBatch(texts);
      } catch (err) {
        if (err instanceof AbortedError || err?.name === "AbortError") throw new AbortedError();
        lastError = err;
        const wait = (err?.rateLimited ? 2500 : 800) * 2 ** attempt + Math.random() * 300;
        if (attempt < MAX_ATTEMPTS - 1) await sleep(wait, this.signal);
      }
    }
    // Jalur cadangan: kirim satu per satu.
    const results = [];
    for (const text of texts) {
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
        try {
          results.push(await this.requestGtx(text));
          done = true;
        } catch (err) {
          if (err instanceof AbortedError || err?.name === "AbortError") throw new AbortedError();
          lastError = err;
          if (attempt === 0) await sleep(700, this.signal);
        }
      }
      if (!done) {
        throw lastError instanceof TranslationError
          ? lastError
          : new TranslationError(
              "Tidak dapat menghubungi Google Translate. Periksa koneksi internet Anda, lalu coba lagi."
            );
      }
    }
    return results;
  }

  /**
   * Terjemahkan banyak potongan teks sekaligus.
   * @param {string[]} atoms teks tanpa spasi berlebih di ujung
   * @param {(done:number,total:number)=>void} [onProgress]
   * @returns {Promise<string[]>} hasil sejajar dengan input
   */
  async translateAll(atoms, onProgress) {
    const out = new Array(atoms.length);
    const pending = new Map(); // teks unik -> daftar indeks
    const totalChars = atoms.reduce((sum, t) => (isTranslatable(t) ? sum + t.length : sum), 0);
    let doneChars = 0;

    // Spasi di ujung teks harus dipertahankan agar kata tidak menempel
    // saat hasil dikembalikan ke XML / file tujuan.
    const shells = atoms.map((atom) => {
      const lead = /^\s*/.exec(atom)[0];
      const trail = /\s*$/.exec(atom)[0];
      const core = atom.slice(lead.length, atom.length - trail.length);
      return { lead, core, trail };
    });

    atoms.forEach((atom, index) => {
      const { lead, core, trail } = shells[index];
      if (!isTranslatable(core)) {
        out[index] = atom;
        return;
      }
      const cached = this.cache.get(core);
      if (cached !== undefined) {
        out[index] = lead + cached + trail;
        doneChars += core.length;
        return;
      }
      if (!pending.has(core)) pending.set(core, []);
      pending.get(core).push(index);
    });

    onProgress?.(doneChars, totalChars);

    const unique = [...pending.keys()];
    const jobs = [];
    let batch = [];
    let chars = 0;

    const flush = () => {
      if (batch.length) jobs.push(batch);
      batch = [];
      chars = 0;
    };

    for (const text of unique) {
      const pieces = splitLong(text);
      if (pieces.length > 1) {
        // Teks sangat panjang: terjemahkan per potongan, gabungkan.
        jobs.push({ long: text, pieces });
        continue;
      }
      if (batch.length >= MAX_ITEMS || (chars + text.length > MAX_CHARS && batch.length)) flush();
      batch.push(text);
      chars += text.length;
    }
    flush();

    let cursor = 0;
    const assign = (core, value) => {
      this.cache.set(core, value);
      for (const index of pending.get(core) || []) {
        const { lead, trail } = shells[index];
        out[index] = lead + value + trail;
      }
    };

    const worker = async () => {
      while (cursor < jobs.length) {
        this.checkAborted();
        const job = jobs[cursor];
        cursor += 1;
        if (Array.isArray(job)) {
          const translations = await this.translateBatch(job);
          job.forEach((text, i) => {
            const value = translations[i] ?? text;
            assign(text, value);
            this.chars += text.length;
            doneChars += text.length;
          });
        } else {
          const parts = [];
          for (const piece of job.pieces) {
            parts.push(await this.requestGtx(piece));
          }
          assign(job.long, parts.join(" "));
          this.chars += job.long.length;
          doneChars += job.long.length;
        }
        onProgress?.(Math.min(doneChars, totalChars), totalChars);
      }
    };

    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, jobs.length) }, worker));
    onProgress?.(totalChars, totalChars);

    for (let i = 0; i < out.length; i += 1) {
      if (out[i] === undefined) out[i] = atoms[i];
    }
    return out;
  }
}

/** Terjemahkan satu blok teks (dipakai panel Teks). */
export async function translatePlainText(text, { source, target, signal, onProgress }) {
  const translator = new Translator({ source, target, signal });
  const parts = text.split(/(\n{2,})/); // pertahankan baris kosong
  const atoms = parts.filter((_, i) => i % 2 === 0);
  const results = await translator.translateAll(atoms, onProgress);
  let k = 0;
  return parts.map((part, i) => (i % 2 === 0 ? results[k++] : part)).join("");
}
