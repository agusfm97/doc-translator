import {
  openZip,
  parseXml,
  serializeXml,
  byLocalName,
  groupByParent,
  translateGroups,
} from "./ooxml.js";

const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function insideAny(el, names) {
  let current = el.parentElement;
  while (current) {
    if (current.namespaceURI === A_NS && names.includes(current.localName)) return true;
    current = current.parentElement;
  }
  return false;
}

export async function translatePptx(file, translator, ctx) {
  const zip = await openZip(file);
  const targets = Object.keys(zip.files).filter((name) =>
    /^ppt\/(slides\/slide|notesSlides\/notesSlide|charts\/chart|diagrams\/data)[\w-]*\d+\.xml$/i.test(name)
  );
  if (!targets.length) {
    throw new Error("File PowerPoint ini tidak memiliki teks yang bisa diterjemahkan.");
  }

  const slides = targets.filter((n) => n.includes("/slides/"));
  const others = targets.filter((n) => !n.includes("/slides/"));

  for (const name of [...slides, ...others]) {
    ctx.stage?.(`Memproses ${name.split("/").pop()}…`);
    const xml = await zip.file(name).async("string");
    const doc = parseXml(xml);
    // Field (mis. nomor slide, tanggal) tidak ikut diterjemahkan.
    const nodes = byLocalName(doc, "t")
      .filter((el) => el.namespaceURI === A_NS)
      .filter((el) => !insideAny(el, ["fld"]));

    const groups = groupByParent(nodes, "p").filter((g) => g.nodes.length);
    if (!groups.length) continue;

    await translateGroups(groups, translator, ctx.onProgress);
    zip.file(name, serializeXml(doc));
  }

  ctx.stage?.("Menyusun file PowerPoint…");
  return zip.generateAsync(
    { type: "blob", compression: "DEFLATE", mimeType: PPTX_MIME },
    (meta) => ctx.onPack?.(meta.percent)
  );
}
