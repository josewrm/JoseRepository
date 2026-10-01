import type { DocxDocument } from "../adapters/docx.ts";
import { linkedInJobId } from "../adapters/job-search.ts";

/**
 * Turns a .docx the candidate brings into vacancies. Three shapes are read:
 *  - a list or table of job links (e.g. "Table 23": one LinkedIn link per line),
 *  - numbered job-description entries ("1. Company — Title", "Location: …",
 *    "Link: …", then the full description) such as an extracted-JD document,
 *  - a Word table with title / company / link / description columns.
 * The text is the human's own document; nothing is added to it.
 */

export interface Vacancy {
  key: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  linkedin_id: string | null;
  /** Full job description when the document carries it. */
  jd_text: string | null;
  label: string | null;
}

const HEADING = /^(\d{1,3}|Jd\d{1,3})[.)]\s+(.{2,140}?)\s+[—–]\s+(.{2,200})$/;
const META = /^(Location|Ubicación|Localização|Link|Enlace|Role|Rol|Posted|Publicado|Type|Tipo)\s*:/i;
const END = /^End of\b|^Fin de\b/i;

export function cleanJobUrl(raw: string): string {
  const id = linkedInJobId(raw);
  if (id) return `https://www.linkedin.com/jobs/view/${id}/`;
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return raw;
  }
}

function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

const keyFor = (url: string, title: string, company: string | null) => {
  const id = url ? linkedInJobId(url) : null;
  return id ?? `doc-${hashKey(url || `${company ?? ""}|${title}`.toLowerCase())}`;
};

function fromEntries(lines: { text: string; links: string[] }[]): Vacancy[] {
  const out: Vacancy[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i].text);
    // A heading counts only when job metadata follows it.
    if (!m || !lines.slice(i + 1, i + 4).some((l) => META.test(l.text))) continue;
    const [, label, company, title] = m;
    let location: string | null = null;
    let url = "";
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const text = lines[j].text;
      if ((HEADING.test(text) && lines.slice(j + 1, j + 4).some((l) => META.test(l.text))) || END.test(text)) break;
      if (/^(Location|Ubicación|Localização)\s*:/i.test(text)) location = text.replace(/^[^:]+:\s*/, "").split("|")[0].trim() || null;
      if (/^(Link|Enlace)\s*:/i.test(text)) url = (lines[j].links[0] ?? /https?:\/\/\S+/.exec(text)?.[0] ?? "").trim();
      if (META.test(text)) continue;
      body.push(text);
    }
    i = j - 1;
    const cleanUrl = url ? cleanJobUrl(url) : "";
    const jd = [`${title} — ${company}`, location ? `Ubicación: ${location}` : "", ...body].filter(Boolean).join("\n").trim();
    out.push({
      key: keyFor(cleanUrl, title, company),
      title: title.trim(),
      company: company.trim(),
      location,
      url: cleanUrl,
      linkedin_id: cleanUrl ? linkedInJobId(cleanUrl) : null,
      jd_text: jd.length >= 200 ? jd : null,
      label,
    });
  }
  return out;
}

const COLS: Record<string, RegExp> = {
  title: /^(puesto|rol|role|title|t[ií]tulo|position|vacante|job)/i,
  company: /^(empresa|company|compa[nñ][ií]a|employer|cliente)/i,
  location: /^(ubicaci[oó]n|location|ciudad|city|pa[ií]s)/i,
  url: /^(link|enlace|url|oferta)/i,
  jd: /^(descripci[oó]n|description|jd|job description)/i,
};

function fromTables(doc: DocxDocument): Vacancy[] {
  const out: Vacancy[] = [];
  for (const table of doc.tables) {
    const [header, ...rows] = table.rows;
    if (!header) continue;
    const col = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, header.findIndex((c) => re.test(c.text.trim()))]));
    if (col.title < 0 && col.url < 0) continue;
    for (const row of rows) {
      const cell = (k: string) => (col[k] >= 0 ? row[col[k]]?.text.trim() ?? "" : "");
      const link = (col.url >= 0 ? row[col.url]?.links[0] : undefined) ?? row.flatMap((c) => c.links)[0] ?? "";
      const url = link ? cleanJobUrl(link) : "";
      const title = cell("title") || (url ? `Oferta ${linkedInJobId(url) ?? ""}`.trim() : "");
      if (!title && !url) continue;
      const jd = cell("jd");
      out.push({ key: keyFor(url, title, cell("company") || null), title, company: cell("company") || null, location: cell("location") || null, url, linkedin_id: url ? linkedInJobId(url) : null, jd_text: jd.length >= 200 ? jd : null, label: null });
    }
  }
  return out;
}

export function vacanciesFromDocx(doc: DocxDocument): Vacancy[] {
  const lines = doc.paragraphs.filter((p) => p.text);
  const found = [...fromEntries(lines), ...fromTables(doc)];
  const seen = new Set(found.map((v) => v.key));
  const hadEntries = found.length > 0;
  // Any other job link in the document becomes a vacancy without a description yet.
  for (const raw of doc.links) {
    const url = cleanJobUrl(raw);
    const id = linkedInJobId(url);
    // Links inside a description (an apply page, a company site) are not vacancies of their own.
    if (!id && (hadEntries || !/job|empleo|career|vacan|stellen|offre|oferta/i.test(url))) continue;
    const key = keyFor(url, "", null);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ key, title: id ? `Oferta LinkedIn ${id}` : new URL(url).hostname, company: null, location: null, url, linkedin_id: id, jd_text: null, label: null });
  }
  const unique = new Map<string, Vacancy>();
  for (const v of found) {
    const prev = unique.get(v.key);
    unique.set(v.key, prev ? { ...prev, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x)) } as Vacancy : v);
  }
  return [...unique.values()];
}
