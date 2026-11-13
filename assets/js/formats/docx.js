import {
  openZip,
  parseXml,
  serializeXml,
  byLocalName,
  groupByParent,
  translateGroups,
} from "./ooxml.js";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function insideAny(el, names) {
  let current = el.parentElement;
  while (current) {
    if (current.namespaceURI === W_NS && names.includes(current.localName)) return true;
    current = current.parentElement;
  }
  return false;
}

export async function translateDocx(file, translator, ctx) {
  const zip = await openZip(file);
  const targets = Object.keys(zip.files).filter((name) =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/i.test(name)
  );
  if (!targets.length) {
    throw new Error("File Word ini tidak memiliki teks yang bisa diterjemahkan.");
  }

  targets.sort((a, b) => (a.includes("document") ? -1 : b.includes("document") ? 1 : 0));

  for (const name of targets) {
    ctx.stage?.(`Membaca ${name.split("/").pop()}…`);
    const xml = await zip.file(name).async("string");
    const doc = parseXml(xml);
    const nodes = byLocalName(doc, "t")
      .filter((el) => el.namespaceURI === W_NS)
      .filter((el) => !insideAny(el, ["del", "moveFrom", "instrText", "delInstrText"]));

    const groups = groupByParent(nodes, "p").filter((g) => g.nodes.length);
    if (!groups.length) continue;

    ctx.stage?.(`Menerjemahkan ${groups.length} paragraf…`);
    await translateGroups(groups, translator, ctx.onProgress);
    zip.file(name, serializeXml(doc));
  }

  ctx.stage?.("Menyusun file Word…");
  return zip.generateAsync(
    { type: "blob", compression: "DEFLATE", mimeType: DOCX_MIME },
    (meta) => ctx.onPack?.(meta.percent)
  );
}
