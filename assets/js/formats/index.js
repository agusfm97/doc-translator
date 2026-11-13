import { translateDocx } from "./docx.js";
import { translatePptx } from "./pptx.js";
import { translateXlsx } from "./xlsx.js";
import { translateHtml, translateSubtitle, translateTextFile } from "./text.js";
import { translatePdf } from "./pdf.js";

export const SUPPORTED_EXTENSIONS = [
  "docx", "pdf", "pptx", "xlsx", "txt", "md", "markdown", "csv", "tsv", "log", "srt", "vtt", "html", "htm",
];

export const LEGACY = {
  doc: "docx",
  ppt: "pptx",
  xls: "xlsx",
};

export function getExtension(name = "") {
  return name.split(".").pop().toLowerCase();
}

export function isSupported(name) {
  const ext = getExtension(name);
  return SUPPORTED_EXTENSIONS.includes(ext) || ext in LEGACY;
}

export function outputName(name, lang) {
  const clean = name.replace(/[\\/:*?"<>|]+/g, "_");
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot + 1) : "txt";
  return `${base}.${lang}.${ext}`;
}

/**
 * @param {File} file
 * @param {object} options
 * @param {import("../translator.js").Translator} options.translator
 * @param {string} options.target
 * @param {"layout"|"text"} [options.pdfMode]
 * @param {object} options.ctx { stage, onProgress, onPack }
 */
export async function translateFile(file, options) {
  const ext = getExtension(file.name);
  if (ext in LEGACY) {
    throw new Error(
      `Format .${ext} (Office lama) belum didukung. Buka file di Office lalu simpan sebagai .${LEGACY[ext]}.`
    );
  }

  const { translator, target, pdfMode, ctx } = options;

  if (ext === "docx") return translateDocx(file, translator, ctx);
  if (ext === "pptx") return translatePptx(file, translator, ctx);
  if (ext === "xlsx") return translateXlsx(file, translator, ctx);
  if (ext === "pdf") return translatePdf(file, translator, ctx, { mode: pdfMode, target });
  if (ext === "html" || ext === "htm") return translateHtml(file, translator, ctx);
  if (ext === "srt" || ext === "vtt") return translateSubtitle(file, translator, ctx);
  if (["txt", "md", "markdown", "csv", "tsv", "log"].includes(ext)) {
    return translateTextFile(file, translator, ctx, ext);
  }

  throw new Error(`Format .${ext} belum didukung.`);
}
