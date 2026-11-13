// Penerjemah PDF: halaman asli dirender ke kanvas, teks lama ditutup,
// lalu teks terjemahan digambar di posisi yang sama (mode tata letak),
// atau disusun ulang menjadi PDF baru (mode teks saja).
import { isTranslatable } from "../translator.js";

const PDFJS_VERSION = "4.10.38";
const RENDER_SCALE = 2;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(
      `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`
    ).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;
      return mod;
    });
  }
  return pdfjsPromise;
}

const FONT_STACKS = {
  cjk: '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Yu Gothic", "Meiryo", "Malgun Gothic", sans-serif',
  arabic: '"Segoe UI", "Noto Naskh Arabic", "Traditional Arabic", Tahoma, sans-serif',
  devanagari: '"Nirmala UI", "Noto Sans Devanagari", Mangal, sans-serif',
  thai: '"Leelawadee UI", "Noto Sans Thai", Tahoma, sans-serif',
  default: '"Segoe UI", Inter, Arial, Helvetica, sans-serif',
};

function fontStackFor(lang) {
  if (/^(zh|ja|ko)/.test(lang)) return FONT_STACKS.cjk;
  if (/^(ar|fa|ur|he)/.test(lang)) return FONT_STACKS.arabic;
  if (/^(hi|mr|ne|bn|gu|ta|te|pa)/.test(lang)) return FONT_STACKS.devanagari;
  if (lang === "th") return FONT_STACKS.thai;
  return FONT_STACKS.default;
}

function wrapText(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = text.split(/\n+/);

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = "";

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);

      // Kata tunggal yang lebih lebar dari kotak: pecah per karakter (CJK).
      if (ctx.measureText(word).width > maxWidth) {
        let chunk = "";
        for (const char of word) {
          if (ctx.measureText(chunk + char).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function sampleBackground(ctx, x, y, w, h) {
  const canvas = ctx.canvas;
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const width = Math.min(canvas.width - left, Math.ceil(w));
  const height = Math.min(canvas.height - top, Math.ceil(h));
  if (width <= 0 || height <= 0) return { color: "#ffffff", dark: false };

  let data;
  try {
    data = ctx.getImageData(left, top, width, height).data;
  } catch {
    return { color: "#ffffff", dark: false };
  }

  // Warna latar diambil dari warna yang paling sering muncul, bukan rata-rata,
  // agar huruf dan garis tabel tidak membuat latar menjadi abu-abu.
  const buckets = new Map();
  const stepX = Math.max(1, Math.floor(width / 40));
  const stepY = Math.max(1, Math.floor(height / 40));
  for (let row = 0; row < height; row += stepY) {
    for (let col = 0; col < width; col += stepX) {
      const i = (row * width + col) * 4;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      const bucket = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      bucket.n += 1;
      bucket.r += data[i];
      bucket.g += data[i + 1];
      bucket.b += data[i + 2];
      buckets.set(key, bucket);
    }
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.n > best.n) best = bucket;
  }
  if (!best) return { color: "#ffffff", dark: false };

  const r = Math.round(best.r / best.n);
  const g = Math.round(best.g / best.n);
  const b = Math.round(best.b / best.n);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { color: `rgb(${r},${g},${b})`, dark: luminance < 0.45 };
}

/** Ubah item teks pdf.js menjadi baris-baris. */
function buildLines(items, mapTransform) {
  const entries = [];
  for (const item of items) {
    const str = (item.str || "").replace(/\u00a0/g, " ");
    if (!str.trim()) continue;
    const m = mapTransform(item.transform);
    const fontSize = Math.hypot(m[2], m[3]) || 10;
    // Lewati teks yang diputar / vertikal.
    if (Math.abs(m[1]) > 0.01 || Math.abs(m[2]) > 0.01) continue;
    entries.push({
      str,
      x: m[4],
      baseline: m[5],
      fontSize,
      width: Math.max(item.width || 0, fontSize * str.length * 0.35),
    });
  }

  entries.sort((a, b) => a.baseline - b.baseline || a.x - b.x);

  const lines = [];
  for (const entry of entries) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(entry.baseline - last.baseline) <= Math.max(last.fontSize * 0.45, 1.6)) {
      last.items.push(entry);
      last.baseline = (last.baseline * (last.items.length - 1) + entry.baseline) / last.items.length;
      last.fontSize = Math.max(last.fontSize, entry.fontSize);
    } else {
      lines.push({ items: [entry], baseline: entry.baseline, fontSize: entry.fontSize });
    }
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.x = Math.min(...line.items.map((i) => i.x));
    line.right = Math.max(...line.items.map((i) => i.x + i.width));
  }

  return lines;
}

function joinItems(items) {
  return items
    .map((item, index) => {
      if (index === 0) return item.str;
      const prev = items[index - 1];
      const gap = item.x - (prev.x + prev.width);
      const needSpace = gap > prev.fontSize * 0.18 && !/\s$/.test(prev.str) && !/^\s/.test(item.str);
      return (needSpace ? " " : "") + item.str;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pecah setiap baris menjadi segmen berdasarkan jarak antar item.
 * Satu sel tabel akan menjadi satu segmen tersendiri, sehingga tidak
 * tergabung dengan sel di sebelahnya.
 */
function buildSegments(lines) {
  const segments = [];

  for (const line of lines) {
    let segment = null;
    for (const item of line.items) {
      if (!segment) {
        segment = {
          items: [item],
          left: item.x,
          right: item.x + item.width,
          baseline: line.baseline,
          fontSize: line.fontSize,
        };
        segments.push(segment);
        continue;
      }
      const gap = item.x - segment.right;
      if (gap > Math.max(segment.fontSize * 1.15, 5)) {
        segment = {
          items: [item],
          left: item.x,
          right: item.x + item.width,
          baseline: line.baseline,
          fontSize: line.fontSize,
        };
        segments.push(segment);
      } else {
        segment.items.push(item);
        segment.right = Math.max(segment.right, item.x + item.width);
        segment.fontSize = Math.max(segment.fontSize, item.fontSize);
      }
    }
  }

  for (const segment of segments) {
    segment.text = joinItems(segment.items);
    segment.width = segment.right - segment.left;
  }

  const filtered = segments.filter((segment) => segment.text);
  // Tentukan batas kanan yang tersedia: sampai segmen berikutnya pada baris
  // yang sama (batas sel tabel) atau sampai tepi kanan halaman.
  filtered.forEach((segment, index) => {
    let limit = null;
    for (let next = index + 1; next < filtered.length; next += 1) {
      const candidate = filtered[next];
      if (Math.abs(candidate.baseline - segment.baseline) > 2.5) break;
      if (candidate.left > segment.right) {
        limit = candidate.left - 3;
        break;
      }
    }
    segment.limitRight = limit;
  });

  return filtered;
}

function buildBlocks(segments, pageWidth) {
  const blocks = [];
  let current = null;

  for (const segment of segments) {
    const prev = current ? current.segments[current.segments.length - 1] : null;
    let merge = false;

    if (prev) {
      const gap = segment.baseline - prev.baseline;
      const overlap = Math.min(prev.right, segment.right) - Math.max(prev.left, segment.left);
      const minWidth = Math.max(1, Math.min(prev.width, segment.width));
      const sameColumn = overlap / minWidth > 0.55;
      const closeY = gap > 0 && gap < Math.max(prev.fontSize * 1.8, 13);
      const sameX = Math.abs(segment.left - prev.left) < Math.max(prev.fontSize * 1.7, 10);
      const similarSize =
        Math.abs(segment.fontSize - prev.fontSize) <= Math.max(1.2, prev.fontSize * 0.2);
      const isProse = prev.width > pageWidth * 0.4;
      merge =
        sameColumn && closeY && sameX && similarSize && isProse && current.segments.length < 24;
    }

    if (merge) {
      current.segments.push(segment);
    } else {
      current = { segments: [segment] };
      blocks.push(current);
    }
  }

  return blocks
    .map((block) => {
      const segments = block.segments;
      const left = Math.min(...segments.map((s) => s.left));
      let right = Math.max(...segments.map((s) => s.right));
      const top = Math.min(...segments.map((s) => s.baseline - s.fontSize * 0.95));
      const bottom = Math.max(...segments.map((s) => s.baseline + s.fontSize * 0.3));
      const fontSize = Math.max(...segments.map((s) => s.fontSize));
      const text = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();

      // Blok satu baris (mis. sel tabel / judul) boleh memakai ruang kosong
      // di sampingnya agar terjemahan tidak mengecil berlebihan.
      if (segments.length === 1) {
        const limit = segments[0].limitRight ?? pageWidth - 24;
        if (limit > right) right = Math.min(limit, pageWidth - 12);
      }

      return { left, right, top, bottom, fontSize, text, lineCount: segments.length };
    })
    .filter((block) => block.text && isTranslatable(block.text));
}

function drawBlockText(ctx, text, block, stack, color) {
  const padding = Math.max(0.5, Math.min(2, block.fontSize * 0.08));
  const maxWidth = Math.max(8, block.right - block.left - padding * 2);
  const maxHeight = Math.max(block.fontSize, block.bottom - block.top);

  let size = block.fontSize;

  // Pastikan kata terpanjang muat dalam satu baris (mis. "Jumlah" di kolom sempit).
  const longest = text.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), "");
  const minSize = Math.max(3.5, block.fontSize * 0.55);
  ctx.font = `${size}px ${stack}`;
  while (size > minSize && ctx.measureText(longest).width > maxWidth) {
    size *= 0.93;
    ctx.font = `${size}px ${stack}`;
  }

  let lines = [];
  while (size >= 3.5) {
    ctx.font = `${size}px ${stack}`;
    lines = wrapText(ctx, text, maxWidth);
    const lineHeight = size * 1.18;
    if (lines.length * lineHeight <= maxHeight + size * 0.3) break;
    size *= 0.94;
  }
  if (!lines.length) return;
  ctx.font = `${size}px ${stack}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";

  // Jangan sampai teks baru menimpa kolom/sel di sebelahnya.
  ctx.save();
  ctx.beginPath();
  ctx.rect(block.left - padding, block.top - padding, block.right - block.left + padding * 2, maxHeight + padding * 2);
  ctx.clip();

  const lineHeight = size * 1.18;
  const totalHeight = lines.length * lineHeight;
  let y = block.top + padding + Math.max(0, (maxHeight - totalHeight) / 2) + size * 0.82;

  for (const line of lines) {
    ctx.fillText(line, block.left + padding, y);
    y += lineHeight;
  }
  ctx.restore();
}

function addCanvasPage(pdf, canvas) {
  const width = canvas.width / RENDER_SCALE;
  const height = canvas.height / RENDER_SCALE;
  const image = canvas.toDataURL("image/jpeg", 0.85);
  pdf.addPage([width, height], width > height ? "landscape" : "portrait");
  pdf.addImage(image, "JPEG", 0, 0, width, height, undefined, "FAST");
}

function createPdf() {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) throw new Error("Pustaka pembuat PDF belum termuat. Muat ulang halaman lalu coba lagi.");
  const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true, orientation: "portrait" });
  // Halaman A4 bawaan dibuang; setiap halaman asli ditambahkan sendiri.
  pdf.deletePage(1);
  return pdf;
}

/** Susun ulang teks hasil terjemahan menjadi PDF A4 yang bersih. */
function layoutCleanPages(pdf, blocks, stack) {
  const width = 595.28;
  const height = 841.89;
  const margin = 54;
  const contentWidth = width - margin * 2;
  const sizes = blocks.map((b) => b.fontSize).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] || 11;

  let canvas = document.createElement("canvas");
  canvas.width = Math.round(width * RENDER_SCALE);
  canvas.height = Math.round(height * RENDER_SCALE);
  let ctx = canvas.getContext("2d");
  ctx.scale(RENDER_SCALE, RENDER_SCALE);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#111827";

  let y = margin;
  let pageStarted = false;

  const startPage = () => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#111827";
    y = margin;
    pageStarted = true;
  };

  const flushPage = () => {
    if (!pageStarted) return;
    addCanvasPage(pdf, canvas);
    canvas = document.createElement("canvas");
    canvas.width = Math.round(width * RENDER_SCALE);
    canvas.height = Math.round(height * RENDER_SCALE);
    ctx = canvas.getContext("2d");
    ctx.scale(RENDER_SCALE, RENDER_SCALE);
    ctx.textBaseline = "alphabetic";
  };

  startPage();

  for (const block of blocks) {
    const heading = block.fontSize > median * 1.35;
    const size = heading ? Math.min(22, Math.max(13, block.fontSize * 1.05)) : Math.min(12, Math.max(9.5, median * 0.98));
    ctx.font = `${heading ? "600 " : ""}${size}px ${stack}`;
    const lines = wrapText(ctx, block.text, contentWidth);
    const lineHeight = size * 1.55;

    if (heading) y += size * 0.5;

    for (const line of lines) {
      if (y + lineHeight > height - margin) {
        flushPage();
        startPage();
      }
      ctx.font = `${heading ? "600 " : ""}${size}px ${stack}`;
      ctx.fillText(line, margin, y + size);
      y += lineHeight;
    }
    y += heading ? size * 0.7 : size * 0.55;
  }

  if (pageStarted) addCanvasPage(pdf, canvas);
}

/**
 * @param {File} file
 * @param {import("../translator.js").Translator} translator
 * @param {object} ctx
 * @param {{ mode: "layout"|"text", target: string }} options
 */
export async function translatePdf(file, translator, ctx, options) {
  const pdfjs = await loadPdfjs();
  ctx.stage?.("Membuka PDF…");

  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new Error("PDF ini dilindungi kata sandi sehingga tidak bisa dibaca.");
    }
    throw new Error("PDF tidak dapat dibuka. File mungkin rusak atau terenkripsi.");
  }

  const totalPages = doc.numPages;
  const pdf = createPdf();
  const stack = fontStackFor(options.target || "en");
  const allBlocks = [];
  const layout = options.mode !== "text";

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    if (translator.signal?.aborted) throw new Error("Dibatalkan");

    ctx.stage?.(`Memproses halaman ${pageNumber} dari ${totalPages}…`);
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const textViewport = page.getViewport({ scale: 1 });
    const mapTransform = (transform) => pdfjs.Util.transform(textViewport.transform, transform);

    if (layout) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: context, viewport }).promise;

      const textContent = await page.getTextContent();
      const lines = buildLines(textContent.items, mapTransform);
      const blocks = buildBlocks(buildSegments(lines), viewport.width / RENDER_SCALE);

      if (blocks.length) {
        const atoms = blocks.map((b) => b.text);
        const translations = await translator.translateAll(atoms, (done, total) => {
          const pageFraction = total ? done / total : 0;
          const overall = ((pageNumber - 1 + pageFraction) / totalPages) * 100;
          ctx.onProgress?.(overall);
        });

        const backgrounds = blocks.map((block) => {
          const pad = Math.max(0.5, Math.min(1.2, block.fontSize * 0.08));
          return sampleBackground(
            context,
            (block.left - pad) * RENDER_SCALE,
            (block.top - pad) * RENDER_SCALE,
            (block.right - block.left + pad * 2) * RENDER_SCALE,
            (block.bottom - block.top + pad * 2) * RENDER_SCALE
          );
        });

        blocks.forEach((block, index) => {
          const translated = translations[index];
          if (!translated || translated === block.text) return;
          const bg = backgrounds[index];
          const pad = Math.max(0.5, Math.min(1.2, block.fontSize * 0.08));

          context.fillStyle = bg.color;
          context.fillRect(
            (block.left - pad) * RENDER_SCALE,
            (block.top - pad) * RENDER_SCALE,
            (block.right - block.left + pad * 2) * RENDER_SCALE,
            (block.bottom - block.top + pad * 2) * RENDER_SCALE
          );

          context.save();
          context.scale(RENDER_SCALE, RENDER_SCALE);
          drawBlockText(
            context,
            translated,
            block,
            stack,
            bg.dark ? "#ffffff" : "#111827"
          );
          context.restore();
        });

        allBlocks.push(...blocks.map((block, index) => ({ ...block, text: translations[index] || block.text })));
      }

      addCanvasPage(pdf, canvas);
      canvas.width = 0;
      canvas.height = 0;
    } else {
      const textContent = await page.getTextContent();
      const lines = buildLines(textContent.items, mapTransform);
      const blocks = buildBlocks(buildSegments(lines), viewport.width / RENDER_SCALE);
      if (blocks.length) {
        const atoms = blocks.map((b) => b.text);
        const translations = await translator.translateAll(atoms, (done, total) => {
          const pageFraction = total ? done / total : 0;
          const overall = ((pageNumber - 1 + pageFraction) / totalPages) * 85;
          ctx.onProgress?.(overall);
        });
        allBlocks.push(...blocks.map((block, index) => ({ ...block, text: translations[index] || block.text })));
      }
      ctx.onProgress?.((pageNumber / totalPages) * 85);
    }

    page.cleanup();
  }

  if (!layout) {
    ctx.stage?.("Menyusun PDF baru…");
    if (!allBlocks.length) throw new Error("Tidak ada teks yang bisa diterjemahkan pada PDF ini.");
    layoutCleanPages(pdf, allBlocks, stack);
    ctx.onProgress?.(95);
  } else if (!allBlocks.length) {
    throw new Error(
      "PDF ini tidak memiliki teks yang bisa diterjemahkan (kemungkinan hasil pindai/gambar). Coba gunakan OCR terlebih dahulu."
    );
  }

  await doc.destroy();
  ctx.stage?.("Menyimpan PDF…");
  return pdf.output("blob");
}
