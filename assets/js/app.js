import { LANGUAGES, languageName } from "./languages.js";
import { Translator, AbortedError, translatePlainText } from "./translator.js";
import { getExtension, isSupported, outputName, translateFile } from "./formats/index.js";

const MAX_SIZE = 60 * 1024 * 1024;
const MAX_FILES = 10;

const state = {
  source: "auto",
  target: "id",
  files: [],
  busy: false,
  controller: null,
  targetController: null,
  results: [],
  urls: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const el = {
  dropzone: $("#dropzone"),
  fileInput: $("#fileInput"),
  fileList: $("#fileList"),
  translateBtn: $("#translateBtn"),
  progressCard: $("#progressCard"),
  progressTitle: $("#progressTitle"),
  progressSub: $("#progressSub"),
  progressPct: $("#progressPct"),
  barFill: $("#barFill"),
  cancelBtn: $("#cancelBtn"),
  resultCard: $("#resultCard"),
  resultGrid: $("#resultGrid"),
  resultSub: $("#resultSub"),
  closeResult: $("#closeResult"),
  previewWrap: $("#previewWrap"),
  previewText: $("#previewText"),
  swapBtn: $("#swapBtn"),
  themeToggle: $("#themeToggle"),
  toast: $("#toast"),
  pdfMode: $("#pdfMode"),
  pdfModeHint: $("#pdfModeHint"),
  sourceText: $("#sourceText"),
  targetText: $("#targetText"),
  charCount: $("#charCount"),
  textStatus: $("#textStatus"),
  translateTextBtn: $("#translateTextBtn"),
  copyBtn: $("#copyBtn"),
  pasteBtn: $("#pasteBtn"),
  downloadTextBtn: $("#downloadTextBtn"),
};

/* ----------------------------- utilitas ----------------------------- */

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

let toastTimer = null;
function toast(message, type = "") {
  el.toast.textContent = message;
  el.toast.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.className = "toast";
  }, type === "error" ? 7000 : 3800);
}

/* ------------------------------- tema ------------------------------- */

const savedTheme = localStorage.getItem("doctranslator-theme");
const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = savedTheme || (prefersDark ? "dark" : "light");

el.themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("doctranslator-theme", next);
});

$("#year").textContent = new Date().getFullYear();

/* --------------------------- pilih bahasa --------------------------- */

function createLangPicker(field, { includeAuto, value, onChange }) {
  const button = $(".lang-btn", field);
  const label = $(".lang-name", field);
  const menu = document.createElement("div");
  menu.className = "lang-menu";
  menu.innerHTML = `
    <input type="text" class="lang-search" placeholder="Cari bahasa…" aria-label="Cari bahasa" />
    <ul class="lang-list" role="listbox"></ul>`;

  const search = $(".lang-search", menu);
  const list = $(".lang-list", menu);
  field.appendChild(menu);

  let current = value;
  let options = [];

  const paint = () => {
    label.textContent = languageName(current);
    button.setAttribute("aria-expanded", "false");
    menu.classList.remove("open");
    list.innerHTML = "";

    const query = search.value.trim().toLowerCase();
    options = LANGUAGES.filter((lang) => {
      if (!query) return true;
      return (
        lang.name.toLowerCase().includes(query) ||
        lang.native.toLowerCase().includes(query) ||
        lang.code.toLowerCase().includes(query)
      );
    });
    if (includeAuto && !query) options = [{ code: "auto", name: "Deteksi otomatis", native: "Auto" }, ...options];

    for (const lang of options) {
      const li = document.createElement("li");
      li.className = "lang-opt";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(lang.code === current));
      li.dataset.code = lang.code;
      li.innerHTML = `<span>${lang.name}${
        lang.native && lang.native !== lang.name ? `<span class="native">${lang.native}</span>` : ""
      }</span><span class="code">${lang.code === "auto" ? "AUTO" : lang.code}</span>`;
      li.addEventListener("click", () => {
        current = lang.code;
        label.textContent = languageName(current);
        menu.classList.remove("open");
        button.setAttribute("aria-expanded", "false");
        onChange?.(current);
      });
      list.appendChild(li);
    }

    if (!options.length) {
      const li = document.createElement("li");
      li.className = "lang-opt";
      li.textContent = "Bahasa tidak ditemukan";
      list.appendChild(li);
    }
  };

  button.addEventListener("click", () => {
    const isOpen = menu.classList.contains("open");
    $$(".lang-menu.open").forEach((m) => m.classList.remove("open"));
    $$(".lang-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (isOpen) return;
    menu.classList.add("open");
    button.setAttribute("aria-expanded", "true");
    search.value = "";
    paint();
    setTimeout(() => search.focus(), 30);
  });

  search.addEventListener("input", paint);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") button.click();
    if (event.key === "Enter") {
      event.preventDefault();
      const first = list.querySelector(".lang-opt[data-code]");
      if (first) first.click();
    }
  });

  document.addEventListener("click", (event) => {
    if (!field.contains(event.target)) {
      menu.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    }
  });

  paint();

  return {
    get value() {
      return current;
    },
    set value(next) {
      current = next;
      paint();
    },
  };
}

const sourcePicker = createLangPicker($("[data-lang='source']"), {
  includeAuto: true,
  value: state.source,
  onChange: (code) => {
    state.source = code;
  },
});

const targetPicker = createLangPicker($("[data-lang='target']"), {
  includeAuto: false,
  value: state.target,
  onChange: (code) => {
    state.target = code;
  },
});

el.swapBtn.addEventListener("click", () => {
  const previousSource = state.source;
  const previousTarget = state.target;
  if (previousSource === "auto") {
    state.source = previousTarget;
    state.target = previousTarget === "id" ? "en" : "id";
  } else {
    state.source = previousTarget;
    state.target = previousSource;
  }
  sourcePicker.value = state.source;
  targetPicker.value = state.target;
  el.swapBtn.classList.toggle("spin");
});

/* ------------------------------- tab -------------------------------- */

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => {
      t.classList.toggle("is-active", t === tab);
      t.setAttribute("aria-selected", String(t === tab));
    });
    const target = tab.dataset.tab;
    $("#panel-doc").hidden = target !== "doc";
    $("#panel-text").hidden = target !== "text";
  });
});

/* --------------------------- file handling --------------------------- */

function renderFiles() {
  el.fileList.innerHTML = "";
  state.files.forEach((file, index) => {
    const ext = getExtension(file.name);
    const li = document.createElement("li");
    li.className = "file-item";
    li.innerHTML = `
      <span class="file-ico ${ext}">${ext.slice(0, 4).toUpperCase()}</span>
      <div class="file-meta">
        <p class="file-name" title="${file.name}">${file.name}</p>
        <p class="file-size">${formatBytes(file.size)}${ext === "pdf" ? ` · ${$("#pdfMode").value === "text" ? "susun ulang teks" : "tata letak dipertahankan"}` : ""}</p>
      </div>
      <button class="file-remove" type="button" aria-label="Hapus ${file.name}" data-index="${index}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>`;
    el.fileList.appendChild(li);
  });

  el.translateBtn.disabled = state.files.length === 0 || state.busy;
  el.translateBtn.querySelector("span").textContent =
    state.files.length > 1 ? `Terjemahkan ${state.files.length} dokumen` : "Terjemahkan dokumen";
}

function addFiles(fileList) {
  const incoming = [...fileList];
  let added = 0;

  for (const file of incoming) {
    if (state.files.length >= MAX_FILES) {
      toast(`Maksimal ${MAX_FILES} file sekali proses.`, "error");
      break;
    }
    if (!isSupported(file.name)) {
      toast(`Format tidak didukung: ${file.name}`, "error");
      continue;
    }
    if (file.size > MAX_SIZE) {
      toast(`${file.name} lebih dari 60 MB.`, "error");
      continue;
    }
    if (file.size === 0) {
      toast(`${file.name} kosong.`, "error");
      continue;
    }
    if (state.files.some((f) => f.name === file.name && f.size === file.size)) continue;
    state.files.push(file);
    added += 1;
  }

  if (added) {
    hideResult();
    renderFiles();
  }
}

el.dropzone.addEventListener("click", () => el.fileInput.click());
el.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    el.fileInput.click();
  }
});

el.fileInput.addEventListener("change", () => {
  addFiles(el.fileInput.files);
  el.fileInput.value = "";
});

["dragenter", "dragover"].forEach((type) => {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((type) => {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === "dragleave" && el.dropzone.contains(event.relatedTarget)) return;
    el.dropzone.classList.remove("dragover");
  });
});
el.dropzone.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

el.fileList.addEventListener("click", (event) => {
  const button = event.target.closest(".file-remove");
  if (!button || state.busy) return;
  state.files.splice(Number(button.dataset.index), 1);
  hideResult();
  renderFiles();
});

el.pdfMode.addEventListener("change", () => {
  const layout = el.pdfMode.value === "layout";
  el.pdfModeHint.textContent = layout
    ? "Halaman asli dipertahankan, teks lama diganti terjemahan."
    : "Teks disusun ulang menjadi PDF baru yang mengalir.";
  renderFiles();
});

/* ----------------------------- progres ----------------------------- */

function showProgress(title) {
  el.progressCard.hidden = false;
  el.progressTitle.textContent = title || "Menerjemahkan…";
  el.progressSub.textContent = "Menyiapkan dokumen";
  el.progressPct.textContent = "0%";
  el.barFill.style.width = "0%";
  el.cancelBtn.hidden = false;
  el.cancelBtn.disabled = false;
  $(".spinner", el.progressCard).style.display = "block";
}

function setProgress(percent, sub) {
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  el.progressPct.textContent = `${safe}%`;
  el.barFill.style.width = `${safe}%`;
  if (sub) el.progressSub.textContent = sub;
}

function hideResult() {
  el.resultCard.hidden = true;
  el.previewWrap.hidden = true;
  el.resultGrid.innerHTML = "";
  state.urls.forEach((url) => URL.revokeObjectURL(url));
  state.urls = [];
  state.results = [];
}

/* --------------------------- unduh hasil --------------------------- */

async function makePreview(blob, name) {
  const ext = getExtension(name);
  if (!["txt", "md", "csv", "tsv", "log", "srt", "vtt", "html", "htm"].includes(ext)) return "";
  try {
    const text = await blob.slice(0, 40000).text();
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return "";
  }
}

async function showResults(results) {
  hideResult();
  state.results = results;

  el.resultSub.textContent =
    results.length === 1
      ? `${results[0].name} · ${formatBytes(results[0].blob.size)}`
      : `${results.length} file · total ${formatBytes(results.reduce((sum, r) => sum + r.blob.size, 0))}`;

  for (const item of results) {
    const url = URL.createObjectURL(item.blob);
    state.urls.push(url);
    const row = document.createElement("div");
    row.className = "result-item";
    row.innerHTML = `
      <span class="file-ico ${getExtension(item.name)}">${getExtension(item.name).slice(0, 4).toUpperCase()}</span>
      <span class="result-name" title="${item.name}">${item.name}</span>
      <span class="result-size">${formatBytes(item.blob.size)}</span>
      <a class="dl-btn" href="${url}" download="${item.name}">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg>
        Unduh
      </a>`;
    el.resultGrid.appendChild(row);
  }

  const preview = await makePreview(results[0].blob, results[0].name);
  if (preview) {
    el.previewText.textContent = preview;
    el.previewWrap.hidden = false;
  }

  el.resultCard.hidden = false;
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

el.closeResult.addEventListener("click", hideResult);

/* -------------------------- proses utama -------------------------- */

el.translateBtn.addEventListener("click", async () => {
  if (state.busy || !state.files.length) return;

  state.busy = true;
  state.controller = new AbortController();
  el.translateBtn.disabled = true;
  hideResult();
  showProgress();

  const translator = new Translator({
    source: state.source,
    target: state.target,
    signal: state.controller.signal,
  });

  const results = [];
  const files = [...state.files];
  const totalFiles = files.length;

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const base = (index / totalFiles) * 100;
      const span = 100 / totalFiles;

      el.progressTitle.textContent =
        totalFiles > 1 ? `File ${index + 1}/${totalFiles}: ${file.name}` : file.name;

      const ctx = {
        stage: (text) => el.progressSub.textContent = text,
        onProgress: (done, total) => {
          const local = typeof total === "number" ? (total ? (done / total) * 100 : 0) : done;
          setProgress(base + (local / 100) * span);
        },
        onPack: (percent) => {
          el.progressSub.textContent = `Menyusun file… ${Math.round(percent)}%`;
        },
      };

      const blob = await translateFile(file, {
        translator,
        target: state.target,
        pdfMode: el.pdfMode.value,
        ctx,
      });

      results.push({ name: outputName(file.name, state.target), blob });
      setProgress(base + span);
    }

    state.files = [];
    renderFiles();
    el.progressCard.hidden = true;
    await showResults(results);
    toast(
      results.length > 1 ? `${results.length} dokumen berhasil diterjemahkan.` : "Dokumen berhasil diterjemahkan.",
      "ok"
    );
  } catch (error) {
    console.error(error);
    if (error instanceof AbortedError || error?.name === "AbortError") {
      el.progressCard.hidden = true;
      toast("Terjemahan dibatalkan.");
    } else {
      el.progressTitle.textContent = "Gagal menerjemahkan";
      el.progressSub.textContent = error?.message || "Terjadi kesalahan tak terduga.";
      el.progressPct.textContent = "—";
      el.barFill.style.width = "100%";
      el.barFill.style.background = "var(--err)";
      $(".spinner", el.progressCard).style.display = "none";
      el.cancelBtn.hidden = true;
      toast(error?.message || "Gagal menerjemahkan dokumen.", "error");
    }
  } finally {
    state.busy = false;
    state.controller = null;
    el.barFill.style.background = "";
    el.translateBtn.disabled = state.files.length === 0;
    renderFiles();
  }
});

el.cancelBtn.addEventListener("click", () => {
  state.controller?.abort();
  el.cancelBtn.disabled = true;
  el.progressSub.textContent = "Membatalkan…";
});

/* --------------------------- panel teks --------------------------- */

function updateCharCount() {
  const count = el.sourceText.value.length;
  el.charCount.textContent = `${count.toLocaleString("id-ID")} karakter`;
}

el.sourceText.addEventListener("input", updateCharCount);
updateCharCount();

el.pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return toast("Clipboard kosong.");
    el.sourceText.value = text;
    updateCharCount();
  } catch {
    toast("Browser menolak akses clipboard. Tempel dengan Ctrl+V.", "error");
  }
});

el.translateTextBtn.addEventListener("click", async () => {
  const text = el.sourceText.value.trim();
  if (!text) {
    toast("Tulis atau tempel teks terlebih dahulu.", "error");
    el.sourceText.focus();
    return;
  }
  if (state.targetController) return;

  state.targetController = new AbortController();
  el.translateTextBtn.disabled = true;
  el.textStatus.textContent = "Menerjemahkan…";
  el.targetText.value = "";

  try {
    const result = await translatePlainText(text, {
      source: state.source,
      target: state.target,
      signal: state.targetController.signal,
      onProgress: (done, total) => {
        const percent = total ? Math.round((done / total) * 100) : 0;
        el.textStatus.textContent = `Menerjemahkan… ${percent}%`;
      },
    });
    el.targetText.value = result;
    el.textStatus.textContent = `${result.length.toLocaleString("id-ID")} karakter`;
  } catch (error) {
    if (error instanceof AbortedError) {
      el.textStatus.textContent = "Dibatalkan";
    } else {
      console.error(error);
      el.textStatus.textContent = "Gagal";
      toast(error?.message || "Gagal menerjemahkan teks.", "error");
    }
  } finally {
    state.targetController = null;
    el.translateTextBtn.disabled = false;
  }
});

el.copyBtn.addEventListener("click", async () => {
  if (!el.targetText.value) return toast("Belum ada hasil untuk disalin.");
  try {
    await navigator.clipboard.writeText(el.targetText.value);
    toast("Terjemahan disalin.", "ok");
  } catch {
    el.targetText.select();
    document.execCommand("copy");
    toast("Terjemahan disalin.", "ok");
  }
});

el.downloadTextBtn.addEventListener("click", () => {
  if (!el.targetText.value) return toast("Belum ada hasil untuk diunduh.");
  const blob = new Blob([el.targetText.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `terjemahan.${state.target}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
});

/* -------------------------- inisialisasi -------------------------- */

renderFiles();

// Cegah pengguna menutup halaman saat proses berjalan.
window.addEventListener("beforeunload", (event) => {
  if (!state.busy) return;
  event.preventDefault();
  event.returnValue = "";
});
