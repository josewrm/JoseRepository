import type { JobPageSnapshot } from "../adapters/job-link.ts";
import { detectLanguage } from "../adapters/html.ts";
import { ALL_TERMS, DOMAIN_TERMS, LANGUAGE_NAMES, findTerms } from "./lexicon.ts";

/**
 * Structured JD. Field names are English (the schema is English); values are
 * verbatim quotes from the posting. Nothing is paraphrased or invented. When
 * the posting is not in English, `translation.status` says so: this host has no
 * translation provider configured, and it will not fake one.
 */

export type RequirementCategory = "skill" | "experience" | "language" | "legal" | "operational" | "education" | "other";

export interface Requirement {
  id: string;
  kind: "must" | "nice";
  text: string;
  category: RequirementCategory;
  keywords: string[];
  min_years: number | null;
  languages: string[];
}

export interface StructuredJd {
  schema: "apply2interview.jd.v1";
  source: { url: string; final_url: string; fetched_at: string; extraction: JobPageSnapshot["extraction"]; snapshot_hash: string };
  language: string;
  translation: { status: "source_is_english" | "not_translated"; note: string };
  title: string | null;
  company: string | null;
  location: string | null;
  employment_type: string | null;
  work_mode: "remote" | "hybrid" | "onsite" | "unknown";
  work_mode_quote: string | null;
  responsibilities: string[];
  must_haves: Requirement[];
  nice_to_haves: Requirement[];
  seniority: { level: "junior" | "mid" | "senior" | "lead" | "unknown"; min_years: number | null; quote: string | null };
  constraints: {
    work_authorization_quote: string | null;
    sponsorship_offered: boolean | null;
    languages_required: string[];
    licenses_or_clearances: string[];
  };
  keywords: string[];
  domains: string[];
  contact_email: string | null;
}

type SectionKind = "must" | "nice" | "responsibilities" | "other";

const HEADING_PATTERNS: [SectionKind, RegExp][] = [
  ["nice", /(nice[- ]to[- ]have|preferred|bonus|plus points?|\(plus\)|desirable|deseable|valorable|se valorar[áa]|wünschenswert|von vorteil|atouts?|souhait|diferencia|gerne gesehen)/i],
  ["other", /(benefits|what we offer|on offer|perks|about us|about \w+:?$|who we are|who are we|our company|ofrecemos|ofrecerte|podemos ofrecer|offer you|beneficios|sobre nosotros|wir bieten|was wir ihnen bieten|über uns|avantages|qui sommes|o que oferecemos|offriamo|salary|compensation|equal opportunit|^why\b|weitere informationen|kontakt|^contact|^source|^facts$|recruitment process|processus de recrutement|haben wir|arbeitgeber auszeichnet|arbeitsumfeld|votre équipe|hiring manager|where is this role)/i],
  ["must", /(requirements?|qualifications?|qualifikation|must[- ]haves?|what you bring|what you need|looking for|you have|will have|your profile|your experience|key skills|skillcheck|tech stack|who you are|about you|skills|requisitos|requerimientos|lo que buscamos|perfil buscamos|qu[ée] perfil|tu perfil|^perfil|imprescindible|se requiere|anforderungen|ihr profil|dein profil|was du mitbringst|was sie mitbringen|voraussetzungen|kompetenzen|ausbildung|fachhintergrund|^profile?$|profil recherch|votre profil|vos comp[ée]tences|exigences|comp[ée]tences requises|qualifica[çc][õo]es|requisiti)/i],
  ["responsibilities", /(responsibilit|what you('| wi)ll do|what type of work|your role|the role|the opportunity|scope|tasks|duties|day to day|responsabilidades|funciones|tus tareas|aufgaben|tätigkeiten|verantwortung|deine rolle|missions?|vos missions|atribui[çc][õo]es|mansioni|challengecheck|^description)/i],
];

function headingKind(line: string): SectionKind | null {
  const raw = line.replace(/^#+\s*/, "").replace(/^[^\p{L}\p{N}¿(#]+/u, "").trim();
  const isHeading =
    line.startsWith("## ") ||
    /^#\w+$/.test(line) ||
    (raw.length <= 80 && /:$/.test(raw)) ||
    (raw.length <= 70 && /\?$/.test(raw)) ||
    (raw.length <= 50 && !/[.!;]$/.test(raw) && raw.split(" ").length <= 7 && !line.startsWith("- "));
  if (!isHeading) return null;
  for (const [kind, pattern] of HEADING_PATTERNS) if (pattern.test(raw.replace(/^#/, ""))) return kind;
  return line.startsWith("## ") ? "other" : null;
}

const YEARS = /(\d{1,2})\s*\+?\s*(?:\+|plus)?\s*(?:years?|yrs?|años|anos|jahre|ans|anni)/i;
const SENIORITY: [StructuredJd["seniority"]["level"], RegExp][] = [
  ["lead", /\b(lead|principal|staff|head of|architect|leiter|responsable)\b/i],
  ["senior", /\b(senior|sr\.?|sênior|expert)\b/i],
  ["junior", /\b(junior|jr\.?|entry[- ]level|graduate|trainee|praktikum|becario)\b/i],
  ["mid", /\b(mid|intermediate|medior|semi[- ]?senior|ssr)\b/i],
];
const LEGAL = /(work permit|work authori[sz]ation|right to work|eligib\w* to work|visa|sponsorship|citizenship|security clearance|background check|permiso de trabajo|arbeitserlaubnis|aufenthaltstitel|autorisation de travail|nationalit)/i;
const OPERATIONAL = /(driv(er'?s|ing) licen[cs]e|carnet de conducir|führerschein|permis de conduire|on[- ]call|shift work|travel (up to|required)|relocat|on[- ]?site|in the office|presencial|vor ort)/i;
const LANGUAGE_REQ = /(fluent|fluency|native|proficien|business[- ]level|written and spoken|c1|c2|b2|nivel|fließend|verhandlungssicher|courant|bilingual|bilingüe)/i;
const EDUCATION = /(degree|bachelor|master|phd|university|título|grado|licenciatura|studium|abschluss|diplôme)/i;
const NO_SPONSOR = /(no|not|unable to|cannot|can't|without)\s+(offer\s+|provide\s+)?(visa\s+)?sponsor/i;
const SPONSOR = /(visa sponsorship (is )?(available|offered|provided)|we (can |will )?sponsor)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function cleanBullet(line: string): string {
  return line.replace(/^[-–•*]\s*/, "").replace(/^##\s*/, "").trim();
}

function categorize(text: string, languages: string[], keywords: string[]): RequirementCategory {
  if (LEGAL.test(text)) return "legal";
  if (OPERATIONAL.test(text)) return "operational";
  if (languages.length && (LANGUAGE_REQ.test(text) || keywords.length === 0)) return "language";
  if (keywords.length) return "skill";
  if (YEARS.test(text)) return "experience";
  if (EDUCATION.test(text)) return "education";
  return "other";
}

function requirement(id: string, kind: "must" | "nice", text: string): Requirement {
  const keywords = findTerms(ALL_TERMS, text);
  const languages = findTerms(LANGUAGE_NAMES, text);
  const years = YEARS.exec(text);
  const isNice = kind === "nice" || /\b(nice to have|is a plus|a plus|preferred|bonus|deseable|valorable|von vorteil|un plus)\b/i.test(text);
  return {
    id,
    kind: isNice ? "nice" : "must",
    text,
    category: categorize(text, languages, keywords),
    keywords,
    min_years: years ? Number(years[1]) : null,
    languages,
  };
}

export function structureJd(snapshot: JobPageSnapshot, snapshotHash: string): StructuredJd {
  const lines = snapshot.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const buckets: Record<SectionKind, string[]> = { must: [], nice: [], responsibilities: [], other: [] };
  const unsectioned: string[] = [];
  let current: SectionKind | null = null;
  for (const line of lines) {
    const kind = headingKind(line);
    if (kind) {
      current = kind;
      continue;
    }
    if (current) buckets[current].push(line);
    else unsectioned.push(line);
  }

  const requirementLines = (list: string[]) => list.map(cleanBullet).filter((l) => l.length >= 3 && l.length <= 400);
  let mustLines = requirementLines(buckets.must);
  let niceLines = requirementLines(buckets.nice);
  if (!mustLines.length && !niceLines.length) {
    // No requirement headings: take bullets that read like requirements.
    const bullets = lines.filter((l) => l.startsWith("- ")).map(cleanBullet);
    mustLines = bullets.filter((l) => /(experience|knowledge|years|proficien|familiar|degree|fluent|skills?|experiencia|conocimientos|erfahrung|kenntnisse|expérience)/i.test(l));
    niceLines = [];
  }
  if (!mustLines.length && !niceLines.length) {
    // Still nothing: keep the posting's own lines that name a known skill (verbatim, outside benefits).
    mustLines = requirementLines([...unsectioned, ...buckets.responsibilities]).filter((l) => findTerms(ALL_TERMS, l).length && l.length <= 200).slice(0, 12);
  }
  let counter = 0;
  const reqs = [
    ...mustLines.map((t) => requirement(`req-${++counter}`, "must", t)),
    ...niceLines.map((t) => requirement(`req-${++counter}`, "nice", t)),
  ];
  const mustHaves = reqs.filter((r) => r.kind === "must");
  const niceToHaves = reqs.filter((r) => r.kind === "nice");

  const relevantText = [...lines.filter((l) => !buckets.other.includes(l))].join("\n");
  const ld = snapshot.json_ld;
  const title = ld?.title ?? firstHeading(lines) ?? snapshot.page_title ?? null;
  const language = detectLanguage(snapshot.text);

  const yearsQuote = [...mustHaves.map((r) => r.text), ...unsectioned].find((l) => YEARS.test(l)) ?? null;
  const minYears = yearsQuote ? Number(YEARS.exec(yearsQuote)![1]) : null;
  const level = SENIORITY.find(([, pattern]) => pattern.test(title ?? ""))?.[0] ?? SENIORITY.find(([, pattern]) => pattern.test(relevantText.slice(0, 600)))?.[0] ?? "unknown";

  const legalQuote = lines.filter((l) => LEGAL.test(l)).map(cleanBullet)[0] ?? null;
  const workModeQuote = lines.filter((l) => /(remote|hybrid|on[- ]?site|in[- ]office|remoto|híbrido|hibrido|presencial|homeoffice|home office|télétravail|teletrabajo)/i.test(l)).map(cleanBullet)[0] ?? null;
  const workMode: StructuredJd["work_mode"] = ld?.remote
    ? "remote"
    : !workModeQuote
      ? "unknown"
      : /hybrid|híbrido|hibrido/i.test(workModeQuote)
        ? "hybrid"
        : /(fully remote|100% remote|remote|remoto|teletrabajo|télétravail)/i.test(workModeQuote) && !/(not remote|no remote)/i.test(workModeQuote)
          ? "remote"
          : "onsite";

  const requiredLanguages = [...new Set(mustHaves.filter((r) => r.category === "language").flatMap((r) => r.languages))];
  const licenses = mustHaves.filter((r) => /(licen[cs]e|clearance|carnet|führerschein|permis)/i.test(r.text)).map((r) => r.text);

  return {
    schema: "apply2interview.jd.v1",
    source: {
      url: snapshot.url,
      final_url: snapshot.final_url,
      fetched_at: snapshot.fetched_at,
      extraction: snapshot.extraction,
      snapshot_hash: snapshotHash,
    },
    language,
    translation: language === "en"
      ? { status: "source_is_english", note: "Posting is in English." }
      : { status: "not_translated", note: `Posting language is ${language}. Values are verbatim quotes; no translation provider is configured, so none was invented.` },
    title,
    company: ld?.company ?? null,
    location: ld?.location ?? null,
    employment_type: ld?.employment_type ?? null,
    work_mode: workMode,
    work_mode_quote: workModeQuote,
    responsibilities: requirementLines(buckets.responsibilities),
    must_haves: mustHaves,
    nice_to_haves: niceToHaves,
    seniority: { level, min_years: minYears, quote: yearsQuote },
    constraints: {
      work_authorization_quote: legalQuote,
      sponsorship_offered: legalQuote ? (NO_SPONSOR.test(legalQuote) ? false : SPONSOR.test(legalQuote) ? true : null) : null,
      languages_required: requiredLanguages,
      licenses_or_clearances: licenses,
    },
    keywords: findTerms(ALL_TERMS, relevantText),
    domains: findTerms(DOMAIN_TERMS, relevantText),
    contact_email: EMAIL.exec(snapshot.text)?.[0] ?? null,
  };
}

function firstHeading(lines: string[]): string | null {
  const heading = lines.find((l) => l.startsWith("## "));
  return heading ? heading.slice(3).trim() : null;
}

export function hasUsableRequirements(jd: StructuredJd): boolean {
  return jd.must_haves.length + jd.nice_to_haves.length > 0;
}
