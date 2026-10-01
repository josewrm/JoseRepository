/**
 * Master CV parser. Splits plain-text / Markdown CVs into sections and keeps
 * every line verbatim so section patches can quote `before` exactly.
 */

export type CvSectionKind =
  | "header" | "summary" | "skills" | "experience" | "education" | "certifications"
  | "languages" | "projects" | "other";

export interface CvSection {
  id: string;
  kind: CvSectionKind;
  heading: string | null;
  /** Verbatim lines (heading excluded). */
  lines: string[];
}

export interface ParsedCv {
  sections: CvSection[];
  text: string;
  language: string;
}

const KIND_PATTERNS: [CvSectionKind, RegExp][] = [
  ["summary", /^(summary|professional summary|profile|about( me)?|objective|perfil( profesional)?|resumen|sobre m[íi]|profil|zusammenfassung|kurzprofil|r[ée]sum[ée]|à propos|sobre)$/i],
  ["skills", /^(skills|technical skills|core skills|key skills|competencies|tech stack|tools|technologies|habilidades|competencias|conocimientos( t[ée]cnicos)?|kenntnisse|fähigkeiten|f[aä]higkeiten|it-kenntnisse|comp[ée]tences|compet[êe]ncias)$/i],
  ["experience", /^(experience|work experience|professional experience|employment( history)?|career|experiencia( profesional| laboral)?|berufserfahrung|beruflicher werdegang|exp[ée]rience( professionnelle)?|experi[êe]ncia( profissional)?|esperienza)$/i],
  ["education", /^(education|academic background|formaci[óo]n( acad[ée]mica)?|educaci[óo]n|estudios|ausbildung|studium|bildung|formation|educa[çc][ãa]o|istruzione)$/i],
  ["certifications", /^(certifications?|certificates|certificaciones|zertifikate|zertifizierungen|certifica[çc][õo]es)$/i],
  ["languages", /^(languages|idiomas|sprachen|langues|l[íi]nguas|lingue)$/i],
  ["projects", /^(projects|proyectos|projekte|projets|projetos)$/i],
];

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|ene|abr|ago|dic|mär|mai|okt|dez|janv|févr|avr|juil|déc)[a-zé]*\\.?";
const DATE = `(?:${MONTH}\\s+)?(?:\\d{1,2}[/.])?(?:19|20)\\d{2}`;
const PRESENT = "(?:present|current|now|today|actual(?:idad|mente)?|presente|heute|aktuell|jetzt|aujourd'hui|atual|oggi)";
export const DATE_RANGE = new RegExp(`(${DATE})\\s*(?:-|–|—|to|a|bis|à|hasta|até)\\s*(${DATE}|${PRESENT})`, "i");

function headingInfo(line: string): { kind: CvSectionKind; heading: string } | null {
  const md = /^#{1,3}\s+(.+)$/.exec(line);
  const raw = (md ? md[1] : line).replace(/[:：]\s*$/, "").trim();
  if (!raw) return null;
  for (const [kind, pattern] of KIND_PATTERNS) if (pattern.test(raw)) return { kind, heading: line };
  const isCaps = raw.length <= 40 && raw === raw.toUpperCase() && /\p{L}{3,}/u.test(raw) && !DATE_RANGE.test(raw);
  if (md && md[0].startsWith("# ") === false && md[0].startsWith("## ")) return { kind: "other", heading: line };
  if (isCaps) return { kind: "other", heading: line };
  return null;
}

export function isBullet(line: string): boolean {
  return /^\s*[-–•*·▪]\s+/.test(line);
}

export function parseCv(text: string, language = "unknown"): ParsedCv {
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: CvSection[] = [];
  let current: CvSection = { id: "header", kind: "header", heading: null, lines: [] };
  const counters: Record<string, number> = {};
  const push = () => {
    if (current.heading !== null || current.lines.some((l) => l.trim())) sections.push(current);
  };
  for (const line of rawLines) {
    const info = line.trim() ? headingInfo(line.trim()) : null;
    if (info && !line.startsWith("###")) {
      push();
      counters[info.kind] = (counters[info.kind] ?? 0) + 1;
      const id = counters[info.kind] === 1 ? info.kind : `${info.kind}-${counters[info.kind]}`;
      current = { id, kind: info.kind, heading: line, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  push();

  // Split experience into one section per role so patches touch 2-4 roles, not the whole history.
  const out: CvSection[] = [];
  for (const section of sections) {
    if (section.kind !== "experience") {
      out.push(trimSection(section));
      continue;
    }
    const entries = splitExperience(section.lines);
    if (entries.length <= 1) {
      out.push(trimSection({ ...section, id: "experience-1" }));
      continue;
    }
    out.push({ id: "experience", kind: "other", heading: section.heading, lines: entries[0].preamble });
    entries.slice(1).forEach((entry, index) => {
      out.push(trimSection({ id: `experience-${index + 1}`, kind: "experience", heading: null, lines: entry.lines }));
    });
  }
  return { sections: out.filter((s) => s.heading !== null || s.lines.length > 0), text, language };
}

function trimSection(section: CvSection): CvSection {
  const lines = [...section.lines];
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return { ...section, lines };
}

/** First item is a preamble (lines before the first role), the rest are roles. */
function splitExperience(lines: string[]): { preamble: string[]; lines: string[] }[] {
  const entries: { preamble: string[]; lines: string[] }[] = [{ preamble: [], lines: [] }];
  let currentLines: string[] | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const startsRole = trimmed.startsWith("###") || (!isBullet(line) && DATE_RANGE.test(trimmed));
    if (startsRole) {
      const carried: string[] = [];
      // A title/company line directly above the dated line belongs to the new role.
      const target = currentLines ?? entries[0].preamble;
      const prev = target[target.length - 1];
      if (!trimmed.startsWith("###") && prev !== undefined && prev.trim() && !isBullet(prev) && !DATE_RANGE.test(prev)) {
        carried.push(target.pop()!);
      }
      currentLines = [...carried, line];
      entries.push({ preamble: [], lines: currentLines });
      continue;
    }
    if (currentLines) currentLines.push(line);
    else entries[0].preamble.push(line);
  }
  return entries;
}

export function sectionText(section: CvSection): string {
  return [section.heading, ...section.lines].filter((l) => l !== null).join("\n");
}

export function renderCv(sections: CvSection[]): string {
  const blocks: string[] = [];
  for (const section of sections) blocks.push(sectionText(section));
  return blocks.join("\n\n");
}

/** Months covered by the union of dated ranges in experience sections. */
export function experienceYears(cv: ParsedCv, now: Date): number {
  const intervals: [number, number][] = [];
  for (const section of cv.sections.filter((s) => s.kind === "experience")) {
    for (const line of section.lines) {
      const match = DATE_RANGE.exec(line);
      if (!match) continue;
      const start = toMonthIndex(match[1], now);
      const end = toMonthIndex(match[2], now);
      if (start !== null && end !== null && end >= start) intervals.push([start, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [start, end] of intervals) {
    const from = Math.max(start, cursor);
    if (end >= from) total += end - from + 1;
    cursor = Math.max(cursor, end + 1);
  }
  return Math.round((total / 12) * 10) / 10;
}

const MONTHS: Record<string, number> = {
  jan: 0, ene: 0, janv: 0, feb: 1, févr: 1, mar: 2, mär: 2, apr: 3, abr: 3, avr: 3, may: 4, mai: 4,
  jun: 5, jul: 6, juil: 6, aug: 7, ago: 7, sep: 8, sept: 8, oct: 9, okt: 9, nov: 10, dec: 11, dic: 11, dez: 11, déc: 11,
};

function toMonthIndex(value: string, now: Date): number | null {
  if (new RegExp(`^${PRESENT}$`, "i").test(value.trim())) return now.getUTCFullYear() * 12 + now.getUTCMonth();
  const year = /(19|20)\d{2}/.exec(value);
  if (!year) return null;
  const numericMonth = /(\d{1,2})[/.](?:19|20)\d{2}/.exec(value);
  const word = /^\p{L}+/u.exec(value.trim().toLowerCase());
  let month = 0;
  if (numericMonth) month = Math.min(11, Math.max(0, Number(numericMonth[1]) - 1));
  else if (word) {
    const key = Object.keys(MONTHS).find((k) => word[0].startsWith(k));
    if (key) month = MONTHS[key];
  }
  return Number(year[0]) * 12 + month;
}
