import { openZip, parseXml, serializeXml, byLocalName, translateGroups } from "./ooxml.js";

const S_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function insideAny(el, names, ns) {
  let current = el.parentElement;
  while (current) {
    if (current.namespaceURI === ns && names.includes(current.localName)) return true;
    current = current.parentElement;
  }
  return false;
}

/** Kelompokkan semua node teks di bawah setiap elemen wadah. */
function groupsByContainer(doc, containerName, textName, ns, skip = []) {
  const groups = [];
  for (const container of byLocalName(doc, containerName)) {
    if (container.namespaceURI !== ns) continue;
    const nodes = Array.from(container.getElementsByTagNameNS(ns, textName)).filter(
      (node) => !skip.some((name) => insideAny(node, [name], ns))
    );
    if (nodes.length) groups.push({ parent: container, nodes });
  }
  return groups;
}

export async function translateXlsx(file, translator, ctx) {
  const zip = await openZip(file);
  const names = Object.keys(zip.files);
  let touched = 0;

  const handle = async (name, buildGroups) => {
    ctx.stage?.(`Memproses ${name.split("/").pop()}…`);
    const xml = await zip.file(name).async("string");
    const doc = parseXml(xml);
    const groups = buildGroups(doc);
    if (!groups.length) return;
    await translateGroups(groups, translator, ctx.onProgress);
    zip.file(name, serializeXml(doc));
    touched += 1;
  };

  for (const name of names) {
    if (/^xl\/sharedStrings\.xml$/i.test(name)) {
      await handle(name, (doc) => groupsByContainer(doc, "si", "t", S_NS, ["rPh"]));
    } else if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
      await handle(name, (doc) => groupsByContainer(doc, "is", "t", S_NS, ["rPh"]));
    } else if (/^xl\/comments\d*\.xml$/i.test(name) || /^xl\/comments\/comment\d+\.xml$/i.test(name)) {
      await handle(name, (doc) => groupsByContainer(doc, "text", "t", S_NS, ["rPh"]));
    } else if (/^xl\/drawings\/drawing\d+\.xml$/i.test(name)) {
      await handle(name, (doc) =>
        groupsByContainer(doc, "p", "t", A_NS, ["fld"]).filter((g) => g.parent.namespaceURI === A_NS)
      );
    }
  }

  if (!touched) {
    throw new Error("File Excel ini tidak memiliki teks yang bisa diterjemahkan.");
  }

  ctx.stage?.("Menyusun file Excel…");
  return zip.generateAsync(
    { type: "blob", compression: "DEFLATE", mimeType: XLSX_MIME },
    (meta) => ctx.onPack?.(meta.percent)
  );
}
