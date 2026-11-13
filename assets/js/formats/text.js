// Format berbasis teks: TXT, Markdown, CSV, SRT/VTT.
import { isTranslatable } from "../translator.js";

const FENCE = /^\s*(```|~~~)/;

function decode(buffer) {
  return new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
}

function detachLineEndings(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { eol, lines: text.split(/\r?\n/) };
}

async function translateLines(lines, translator, onProgress, { markdown = false } = {}) {
  const atoms = [];
  const map = []; // index atom -> index baris
  let inFence = false;

  lines.forEach((line, index) => {
    if (markdown && FENCE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (!line.trim()) return;
    if (markdown && /^\s*([-*_])\1{2,}\s*$/.test(line)) return; // garis horizontal
    if (markdown && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return; // tabel pemisah
    if (!isTranslatable(line)) return;
    atoms.push(line);
    map.push(index);
  });

  const results = await translator.translateAll(atoms, onProgress);
  const out = [...lines];
  map.forEach((lineIndex, i) => {
    out[lineIndex] = results[i];
  });
  return out;
}

export async function translateTextFile(file, translator, ctx, ext) {
  ctx.stage?.("Membaca teks…");
  const text = decode(await file.arrayBuffer());
  const { eol, lines } = detachLineEndings(text);

  const markdown = ext === "md" || ext === "markdown";
  const result = await translateLines(lines, translator, ctx.onProgress, { markdown });
  return new Blob([result.join(eol)], { type: "text/plain;charset=utf-8" });
}

export async function translateSubtitle(file, translator, ctx) {
  ctx.stage?.("Membaca subtitle…");
  const text = decode(await file.arrayBuffer());
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const blocks = text.split(/\r?\n\s*\r?\n/);
  const atoms = [];
  const slots = []; // {block, line}

  blocks.forEach((block, b) => {
    const lines = block.split(/\r?\n/);
    const cueIndex = lines.findIndex((line) => line.includes("-->"));
    if (cueIndex === -1) return;
    lines.forEach((line, l) => {
      if (l <= cueIndex) return;
      const cleaned = line.replace(/<[^>]+>/g, "").trim();
      if (!isTranslatable(cleaned)) return;
      atoms.push(cleaned);
      slots.push({ b, l, prefix: line.match(/^<[^>]+>/)?.[0] || "" });
    });
  });

  const results = await translator.translateAll(atoms, ctx.onProgress);
  const outBlocks = blocks.map((block) => block.split(/\r?\n/));
  slots.forEach((slot, i) => {
    outBlocks[slot.b][slot.l] = slot.prefix ? `${slot.prefix}${results[i]}` : results[i];
  });
  return new Blob([outBlocks.map((lines) => lines.join(eol)).join(eol + eol)], {
    type: "text/plain;charset=utf-8",
  });
}

const SKIP_TAGS = new Set(["script", "style", "code", "pre", "textarea", "noscript", "svg", "math"]);
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "dd", "dt",
  "figcaption", "blockquote", "div", "section", "article", "header", "footer",
  "button", "label", "summary", "caption", "main", "nav", "aside",
]);

function closestBlock(node, stopAt) {
  let current = node.parentElement;
  while (current && current !== stopAt) {
    if (BLOCK_TAGS.has(current.localName.toLowerCase())) return current;
    current = current.parentElement;
  }
  return stopAt;
}

export async function translateHtml(file, translator, ctx) {
  ctx.stage?.("Membaca HTML…");
  const text = decode(await file.arrayBuffer());
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");
  if (!doc.body) throw new Error("Struktur HTML tidak dapat dibaca.");

  const groups = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let current = null;
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue;
    if (!value || !value.trim()) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    let skip = false;
    let probe = parent;
    while (probe && probe !== doc.body) {
      if (SKIP_TAGS.has(probe.localName)) { skip = true; break; }
      if (probe.isContentEditable) { skip = true; break; }
      probe = probe.parentElement;
    }
    if (skip || !isTranslatable(value)) continue;

    const block = closestBlock(node, doc.body);
    if (!current || current.parent !== block) {
      current = { parent: block, nodes: [] };
      groups.push(current);
    }
    current.nodes.push(node);
  }

  if (groups.length) {
    const atoms = groups.map((g) => g.nodes.map((n) => n.nodeValue).join(""));
    const results = await translator.translateAll(atoms, ctx.onProgress);
    results.forEach((translated, index) => {
      if (!translated || translated === atoms[index]) return;
      const nodes = groups[index].nodes;
      if (nodes.length === 1) {
        nodes[0].nodeValue = translated;
        return;
      }
      // Bagi hasil per kata agar tag inline (tebal, miring, tautan) tetap
      // berada pada kata yang wajar.
      const counts = nodes.map((n) => (n.nodeValue.match(/\S+/g) || []).length);
      const totalWords = counts.reduce((a, b) => a + b, 0);
      const words = translated.split(/\s+/).filter(Boolean);

      if (totalWords > 0 && words.length >= nodes.length) {
        let start = 0;
        nodes.forEach((n, i) => {
          const remaining = words.length - start;
          const take =
            i === nodes.length - 1
              ? remaining
              : Math.max(
                  0,
                  Math.min(
                    remaining - (nodes.length - 1 - i),
                    Math.round((counts[i] / totalWords) * words.length)
                  )
                );
          const chunk = words.slice(start, start + take).join(" ");
          start += take;
          const lead = /^\s/.test(n.nodeValue) ? " " : "";
          const trail = /\s$/.test(n.nodeValue) ? " " : "";
          n.nodeValue = lead + chunk + trail;
        });
        return;
      }

      // Cadangan: bagi berdasarkan panjang teks.
      const weights = nodes.map((n) => Math.max(n.nodeValue.length, 1));
      const total = weights.reduce((a, b) => a + b, 0);
      let acc = 0;
      let start = 0;
      nodes.forEach((n, i) => {
        if (i === nodes.length - 1) {
          n.nodeValue = translated.slice(start);
          return;
        }
        acc += weights[i];
        let cut = Math.round((acc / total) * translated.length);
        const space = translated.indexOf(" ", cut);
        if (space !== -1 && space - cut < 12) cut = space + 1;
        if (cut < start) cut = start;
        n.nodeValue = translated.slice(start, cut);
        start = cut;
      });
    });
  }

  const doctype = text.match(/<!doctype[^>]*>/i)?.[0] || "<!DOCTYPE html>";
  return new Blob([`${doctype}\n${doc.documentElement.outerHTML}`], { type: "text/html;charset=utf-8" });
}
