/**
 * Minimal .docx reader: paragraphs (with bullet markers and hyperlinks) and
 * tables. No dependencies: the zip container is read by hand and inflated with
 * the platform's DecompressionStream, so the same code runs in Node and the browser.
 */

export interface DocxParagraph {
  text: string;
  links: string[];
  bullet: boolean;
}

export interface DocxTable {
  rows: { text: string; links: string[] }[][];
}

export interface DocxDocument {
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
  /** Every external link in reading order, from hyperlinks, HYPERLINK fields and plain-text URLs. */
  links: string[];
}

export class DocxError extends Error {}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads the named entries of a zip archive. */
export async function unzipEntries(bytes: Uint8Array, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new DocxError("El archivo no es un .docx válido (no es un zip).");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const decoder = new TextDecoder("utf-8");
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new DocxError("Directorio del zip dañado.");
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compSize);
    if (method === 0) out.set(name, decoder.decode(raw));
    else if (method === 8) out.set(name, decoder.decode(await inflateRaw(raw)));
    else throw new DocxError(`Compresión zip no soportada (${method}).`);
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m);

const URL_RE = /https?:\/\/[^\s"<>]+/g;

function paragraph(xml: string, rels: Map<string, string>): DocxParagraph {
  const links: string[] = [];
  for (const m of xml.matchAll(/<w:hyperlink\b[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.get(m[1]);
    if (target) links.push(target);
  }
  for (const m of xml.matchAll(/HYPERLINK\s+(?:&quot;|")([^"&]+)(?:&quot;|")/g)) links.push(decode(m[1]));
  let text = "";
  for (const m of xml.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "").matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) {
    text += m[1] !== undefined ? decode(m[1]) : m[0] === "<w:tab/>" ? "\t" : "\n";
  }
  text = text.trim();
  for (const m of text.matchAll(URL_RE)) links.push(m[0]);
  return { text, links: [...new Set(links)], bullet: /<w:numPr>/.test(xml) };
}

export async function readDocx(bytes: Uint8Array): Promise<DocxDocument> {
  const files = await unzipEntries(bytes, (n) => n === "word/document.xml" || n === "word/_rels/document.xml.rels");
  const doc = files.get("word/document.xml");
  if (!doc) throw new DocxError("El .docx no tiene word/document.xml.");
  const rels = new Map<string, string>();
  for (const m of (files.get("word/_rels/document.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target && /TargetMode="External"/.test(m[0])) rels.set(id, decode(target));
  }
  const body = doc.slice(doc.indexOf("<w:body>"), doc.lastIndexOf("</w:body>"));
  const paragraphs: DocxParagraph[] = [];
  const tables: DocxTable[] = [];
  for (const block of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const xml = block[0];
    if (xml.startsWith("<w:tbl>")) {
      const rows = [...xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((tr) =>
        [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) => {
          const ps = [...tc[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((x) => paragraph(x[0], rels));
          return { text: ps.map((x) => (x.bullet ? `- ${x.text}` : x.text)).filter(Boolean).join("\n"), links: [...new Set(ps.flatMap((x) => x.links))] };
        }),
      );
      tables.push({ rows });
      for (const row of rows) for (const cell of row) paragraphs.push({ text: cell.text, links: cell.links, bullet: false });
    } else if (!xml.endsWith("/>") || xml.includes("</w:p>")) {
      paragraphs.push(paragraph(xml, rels));
    }
  }
  return { paragraphs, tables, links: [...new Set(paragraphs.flatMap((p) => p.links))] };
}

/** Plain text of a document, one paragraph per line, bullets as "- ". */
export function docxText(doc: DocxDocument): string {
  return doc.paragraphs.map((p) => (p.bullet && p.text ? `- ${p.text}` : p.text)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
