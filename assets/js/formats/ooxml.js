// Utilitas untuk file OOXML (docx/pptx/xlsx) berbasis ZIP + XML.

export async function openZip(file) {
  if (!window.JSZip) {
    throw new Error("Pustaka JSZip belum termuat. Periksa koneksi internet lalu muat ulang halaman.");
  }
  const buffer = await file.arrayBuffer();
  return window.JSZip.loadAsync(buffer);
}

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("Struktur XML dokumen tidak dapat dibaca.");
  }
  return doc;
}

export function serializeXml(doc) {
  return new XMLSerializer().serializeToString(doc);
}

export function byLocalName(root, localName) {
  return Array.from(root.getElementsByTagNameNS("*", localName));
}

export function closestByLocalName(node, localName) {
  let current = node.parentNode;
  while (current && current.nodeType === 1) {
    if (current.localName === localName) return current;
    current = current.parentNode;
  }
  return null;
}

function setText(el, value) {
  el.textContent = value;
  if (value !== value.trim() && typeof el.setAttributeNS === "function") {
    el.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  }
}

/** Cari posisi potong terdekat pada batas kata. */
function snap(text, position) {
  if (position <= 0) return 0;
  if (position >= text.length) return text.length;
  for (let offset = 0; offset <= 14; offset += 1) {
    const after = position + offset;
    if (after < text.length && /\s/.test(text[after])) return after + 1;
    const before = position - offset;
    if (before > 0 && /\s/.test(text[before])) return before + 1;
  }
  return position;
}

/**
 * Bagikan satu hasil terjemahan ke beberapa node teks, secara proporsional
 * terhadap panjang teks aslinya. Tujuannya mempertahankan format per kata
 * (mis. satu kata tebal di tengah kalimat).
 */
export function distributeText(nodes, translated) {
  if (!nodes.length) return;
  if (nodes.length === 1) {
    setText(nodes[0], translated);
    return;
  }

  // Bagi per kata agar format (mis. satu kata tebal) tetap di kata yang tepat.
  const counts = nodes.map((node) => (node.textContent.match(/\S+/g) || []).length);
  const totalWords = counts.reduce((a, b) => a + b, 0);
  const words = translated.split(/\s+/).filter(Boolean);

  if (totalWords > 0 && words.length >= nodes.length) {
    let cursor = 0;
    nodes.forEach((node, index) => {
      const remaining = words.length - cursor;
      const take =
        index === nodes.length - 1
          ? remaining
          : Math.max(
              0,
              Math.min(
                remaining - (nodes.length - 1 - index),
                Math.round((counts[index] / totalWords) * words.length)
              )
            );
      const chunk = words.slice(cursor, cursor + take).join(" ");
      cursor += take;
      const lead = /^\s/.test(node.textContent) ? " " : "";
      const trail = /\s$/.test(node.textContent) ? " " : "";
      setText(node, lead + chunk + trail);
    });
    return;
  }

  const weights = nodes.map((node) => Math.max(node.textContent.length, 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const positions = [];
  let acc = 0;
  let prev = 0;

  for (let i = 0; i < nodes.length - 1; i += 1) {
    acc += weights[i];
    let cut = snap(translated, Math.round((acc / total) * translated.length));
    if (cut < prev) cut = prev;
    positions.push(cut);
    prev = cut;
  }

  let start = 0;
  nodes.forEach((node, index) => {
    const end = index < positions.length ? positions[index] : translated.length;
    setText(node, translated.slice(start, end));
    start = end;
  });
}

/** Kelompokkan node teks berdasarkan elemen induk (paragraf). */
export function groupByParent(nodes, parentName) {
  const groups = [];
  let current = null;
  for (const node of nodes) {
    const parent = closestByLocalName(node, parentName);
    if (!parent) continue;
    if (!current || current.parent !== parent) {
      current = { parent, nodes: [] };
      groups.push(current);
    }
    current.nodes.push(node);
  }
  return groups;
}

/** Ambil teks gabungan sebuah grup node. */
export function groupText(group) {
  return group.nodes.map((node) => node.textContent).join("");
}

/**
 * Jalankan terjemahan untuk semua grup, lalu tulis hasilnya kembali.
 * Grup yang teksnya kosong / tidak bisa diterjemahkan dilewati.
 */
export async function translateGroups(groups, translator, onProgress) {
  const atoms = groups.map((group) => groupText(group));
  const results = await translator.translateAll(atoms, onProgress);
  results.forEach((translated, index) => {
    if (translated && translated !== atoms[index]) {
      distributeText(groups[index].nodes, translated);
    }
  });
}
