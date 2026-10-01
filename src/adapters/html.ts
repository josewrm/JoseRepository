// Minimal HTML -> text conversion. Keeps headings (as "## ") and list items
// (as "- ") so the JD structurer can find sections. No DOM dependency.

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  bull: "•", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', middot: "·",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
  ouml: "ö", auml: "ä", szlig: "ß", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó",
  Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü", Ouml: "Ö", Auml: "Ä", ccedil: "ç", agrave: "à",
  egrave: "è", ecirc: "ê", ocirc: "ô", atilde: "ã", otilde: "õ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code] ?? match;
  });
}

export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, inner: string) => `\n## ${inner.replace(/<[^>]+>/g, " ")}\n`);
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>\s*(<br\s*\/?>|<\/p>)/gi, (_m, _t, inner: string) => `\n## ${inner.replace(/<[^>]+>/g, " ")}\n`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|ul|ol|li|tr|table|header|main|h[1-6])>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  const lines = s
    .split(/\n/)
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .map((line) => line.replace(/^[•●▪◦·*]\s*/, "- "))
    .filter((line) => line.length > 0 && line !== "-" && line !== "##");
  return lines.join("\n");
}

export function pageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : null;
}

/** Extracts schema.org JobPosting objects from JSON-LD blocks. */
export function jobPostingJsonLd(html: string): Record<string, any> | null {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const found = findJobPosting(parsed);
    if (found) return found;
  }
  return null;
}

function findJobPosting(value: unknown): Record<string, any> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, any>;
    const type = record["@type"];
    if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return record;
    if (record["@graph"]) return findJobPosting(record["@graph"]);
  }
  return null;
}

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "with", "you", "our", "for", "will", "are", "experience", "team", "of", "to", "in", "we", "your"],
  es: ["el", "la", "los", "las", "y", "con", "para", "del", "experiencia", "equipo", "de", "en", "que", "una", "por"],
  de: ["der", "die", "das", "und", "mit", "für", "wir", "sie", "erfahrung", "ihre", "eine", "zu", "von", "bei", "du"],
  fr: ["le", "la", "les", "et", "avec", "pour", "des", "vous", "expérience", "équipe", "une", "du", "en", "nous", "votre"],
  pt: ["o", "os", "as", "e", "com", "para", "do", "da", "experiência", "equipe", "uma", "em", "que", "você", "na"],
  it: ["il", "lo", "gli", "e", "con", "per", "del", "della", "esperienza", "squadra", "una", "di", "che", "sono", "nel"],
};

/** Stopword-count language guess. Returns "unknown" when the signal is weak. */
export function detectLanguage(text: string): string {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 20) return "unknown";
  const counts: Record<string, number> = {};
  const index = new Map<string, string[]>();
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    for (const word of list) index.set(word, [...(index.get(word) ?? []), lang]);
  }
  for (const word of words) {
    for (const lang of index.get(word) ?? []) counts[lang] = (counts[lang] ?? 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 5) return "unknown";
  return ranked[0][0];
}
