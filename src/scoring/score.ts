import { ALL_TERMS, DOMAIN_TERMS, LANGUAGE_NAMES, findTerms, textHasTerm } from "./lexicon.ts";
import { experienceYears, isBullet, type ParsedCv } from "./cv.ts";
import type { Requirement, StructuredJd } from "./jd.ts";
import { applyToInterviewPct, type PercentageResult } from "./percentage.ts";

/** Candidate facts supplied by the HumanWorker. Treated as truth, like the master CV. */
export interface CandidateFacts {
  name?: string;
  location?: string;
  visa?: string;
  languages?: string[];
  willing_to_relocate?: boolean;
  other?: string;
}

export type MatchStatus = "met" | "not_met" | "unknown";

export interface RequirementMatch {
  requirement_id: string;
  kind: "must" | "nice";
  category: Requirement["category"];
  text: string;
  status: MatchStatus;
  basis: string;
  matched_keywords: string[];
  missing_keywords: string[];
  evidence_quotes: string[];
}

export interface ScoreSheet {
  schema: "apply2interview.score_sheet.v1";
  computed_from: "master_cv_and_candidate_facts";
  jd_snapshot_hash: string;
  master_cv_hash: string;
  fit_score: { value: number; method: string };
  requirements: RequirementMatch[];
  facts_used: { cv_experience_years: number; cv_domains: string[]; jd_domains: string[]; jd_keywords: string[]; cv_keywords_matched: string[]; quantified_bullets: string[] };
  unverified: string[];
  apply_to_interview_pct: PercentageResult;
}

const STOP = new Set(
  "the and with for you our your are will have has this that from into able work working using strong good great solid plus must should can who what how all any etc experience knowledge skills years year team teams role level ability understanding including within across other more least".split(" "),
);
const QUANTIFIED = /(\d+(?:[.,]\d+)?\s?(?:%|x\b|k\b|m\b|€|\$|£|users|customers|clients|hours|days|weeks|ms\b|projects|people|engineers|developers|million|mill|millones|millionen|tickets|countries|sites|warehouses))|([€$£]\s?\d)/i;

function factsText(facts: CandidateFacts): string {
  return [facts.name, facts.location, facts.visa, ...(facts.languages ?? []), facts.other].filter(Boolean).join("\n");
}

function stripBullet(line: string): string {
  return line.replace(/^\s*[-–•*·▪]\s+/, "").trim();
}

const QUOTE_ORDER = ["experience", "projects", "summary", "certifications", "skills", "education", "languages", "other", "header"];

function quotesFor(cv: ParsedCv, test: (line: string) => boolean, limit = 3): string[] {
  const quotes: string[] = [];
  // Experience bullets are the strongest evidence; skills lists the weakest.
  const ordered = [...cv.sections].sort((a, b) => QUOTE_ORDER.indexOf(a.kind) - QUOTE_ORDER.indexOf(b.kind));
  for (const section of ordered) {
    for (const line of section.lines) {
      const clean = stripBullet(line);
      if (clean && test(line) && !quotes.includes(clean)) quotes.push(clean.length > 220 ? `${clean.slice(0, 217)}...` : clean);
      if (quotes.length >= limit) return quotes;
    }
  }
  return quotes;
}

function contentWords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/\p{L}[\p{L}\p{N}+#./-]{3,}/gu) ?? []).filter((w) => !STOP.has(w)))];
}

export function visaStatus(facts: CandidateFacts): "authorized" | "needs_sponsorship" | "unknown" {
  const visa = (facts.visa ?? "").toLowerCase();
  if (!visa.trim()) return "unknown";
  if (/(no (visa |sponsorship )?(needed|required)|do(n't| not) (need|require)|citizen|permanent resident|authori[sz]ed|work permit|right to work|eu passport|green card|blue card|nie|residencia)/.test(visa)) return "authorized";
  if (/(need|require|sponsor)/.test(visa)) return "needs_sponsorship";
  return "unknown";
}

function languageMatch(requirement: Requirement, cv: ParsedCv, facts: CandidateFacts): { status: MatchStatus; basis: string; quotes: string[] } {
  const declared = (facts.languages ?? []).join(", ");
  const results = requirement.languages.map((language) => {
    if (declared && textHasTerm(LANGUAGE_NAMES, language, declared)) return "met";
    if (textHasTerm(LANGUAGE_NAMES, language, cv.text)) return "met";
    return declared ? "not_met" : "unknown";
  });
  const status: MatchStatus = results.every((r) => r === "met") ? "met" : results.includes("not_met") ? "not_met" : "unknown";
  const quotes = quotesFor(cv, (line) => requirement.languages.some((language) => textHasTerm(LANGUAGE_NAMES, language, line)), 2);
  if (declared && status !== "unknown") quotes.push(`Candidate facts: languages = ${declared}`);
  return { status, basis: declared ? "Candidate facts languages and CV text." : "CV text only; no languages in candidate facts.", quotes };
}

function evaluate(requirement: Requirement, cv: ParsedCv, facts: CandidateFacts, cvYears: number, jd: StructuredJd): RequirementMatch {
  const base = {
    requirement_id: requirement.id,
    kind: requirement.kind,
    category: requirement.category,
    text: requirement.text,
    matched_keywords: [] as string[],
    missing_keywords: [] as string[],
    evidence_quotes: [] as string[],
  };
  const truth = `${cv.text}\n${factsText(facts)}`;

  if (requirement.category === "language") {
    const result = languageMatch(requirement, cv, facts);
    return { ...base, status: result.status, basis: result.basis, evidence_quotes: result.quotes };
  }

  if (requirement.category === "legal") {
    if (/(visa|sponsor|work permit|authori[sz]ation|right to work|eligib|permiso|arbeitserlaubnis|autorisation)/i.test(requirement.text)) {
      const visa = visaStatus(facts);
      if (visa === "authorized") return { ...base, status: "met", basis: "Candidate facts state work authorization.", evidence_quotes: [`Candidate facts: visa = ${facts.visa}`] };
      if (visa === "needs_sponsorship" && jd.constraints.sponsorship_offered !== true) {
        return { ...base, status: "not_met", basis: "Candidate needs sponsorship and the posting does not offer it.", evidence_quotes: [`Candidate facts: visa = ${facts.visa}`] };
      }
      if (visa === "needs_sponsorship") return { ...base, status: "met", basis: "Posting offers sponsorship.", evidence_quotes: [`Candidate facts: visa = ${facts.visa}`] };
      return { ...base, status: "unknown", basis: "No work authorization in candidate facts." };
    }
    const quotes = quotesFor(cv, (line) => contentWords(requirement.text).some((w) => line.toLowerCase().includes(w)), 2);
    return { ...base, status: quotes.length ? "met" : "unknown", basis: quotes.length ? "Mentioned in CV." : "Not mentioned in CV or candidate facts.", evidence_quotes: quotes };
  }

  if (requirement.category === "operational") {
    if (/(relocat|on[- ]?site|in the office|presencial|vor ort)/i.test(requirement.text)) {
      return { ...base, ...locationMatch(jd, facts) };
    }
    const words = contentWords(requirement.text);
    const hit = words.length > 0 && words.some((w) => truth.toLowerCase().includes(w) && !["required", "travel"].includes(w));
    const quotes = hit ? quotesFor(cv, (line) => words.some((w) => line.toLowerCase().includes(w)), 2) : [];
    return { ...base, status: hit ? "met" : "unknown", basis: hit ? "Mentioned in CV or candidate facts." : "Not stated in CV or candidate facts.", evidence_quotes: quotes };
  }

  if (requirement.keywords.length) {
    const matched = requirement.keywords.filter((term) => textHasTerm(ALL_TERMS, term, truth));
    const missing = requirement.keywords.filter((term) => !matched.includes(term));
    const alternatives = /\b(or|o|oder|ou|any of|one of)\b|\//i.test(requirement.text);
    const needed = alternatives ? 1 : Math.max(1, Math.ceil(requirement.keywords.length / 2));
    let status: MatchStatus = matched.length >= needed ? "met" : "not_met";
    let basis = `${matched.length}/${requirement.keywords.length} required terms found in master CV${alternatives ? " (alternatives accepted)" : ""}.`;
    if (status === "met" && requirement.min_years !== null && cvYears < requirement.min_years) {
      status = "not_met";
      basis += ` Asks for ${requirement.min_years}+ years; dated CV experience totals ${cvYears} years.`;
    }
    const quotes = quotesFor(cv, (line) => matched.some((term) => textHasTerm(ALL_TERMS, term, line)));
    return { ...base, status, basis, matched_keywords: matched, missing_keywords: missing, evidence_quotes: quotes };
  }

  if (requirement.min_years !== null) {
    const status: MatchStatus = cvYears >= requirement.min_years ? "met" : "not_met";
    const quotes = quotesFor(cv, (line) => !isBullet(line) && /(19|20)\d{2}/.test(line), 3);
    return { ...base, status, basis: `Asks for ${requirement.min_years}+ years; dated CV experience totals ${cvYears} years.`, evidence_quotes: status === "met" ? quotes : [] };
  }

  const words = contentWords(requirement.text);
  const found = words.filter((w) => cv.text.toLowerCase().includes(w));
  const ratio = words.length ? found.length / words.length : 0;
  if (requirement.category === "education") {
    const degree = /(bachelor|master|degree|engineer|ingenier|licenci|grado|diplom|bsc|msc|phd|b\.sc|m\.sc|universit)/i;
    const quotes = quotesFor(cv, (line) => degree.test(line), 2);
    return { ...base, status: quotes.length ? "met" : "unknown", basis: quotes.length ? "Degree found in CV." : "No degree stated in CV.", evidence_quotes: quotes };
  }
  const status: MatchStatus = ratio >= 0.6 ? "met" : "not_met";
  const quotes = status === "met" ? quotesFor(cv, (line) => found.filter((w) => line.toLowerCase().includes(w)).length >= Math.min(2, found.length), 2) : [];
  return { ...base, status, basis: `${found.length}/${words.length} content words found in master CV.`, evidence_quotes: quotes };
}

function locationMatch(jd: StructuredJd, facts: CandidateFacts): { status: MatchStatus; basis: string; evidence_quotes: string[] } {
  if (jd.work_mode === "remote") return { status: "met", basis: "Posting is remote.", evidence_quotes: jd.work_mode_quote ? [jd.work_mode_quote] : [] };
  const place = (jd.location ?? "").split(",")[0].trim().toLowerCase();
  const home = (facts.location ?? "").toLowerCase();
  if (place && home && home.includes(place)) return { status: "met", basis: "Candidate location matches the posting location.", evidence_quotes: [`Candidate facts: location = ${facts.location}`] };
  if (facts.willing_to_relocate === true) return { status: "met", basis: "Candidate is willing to relocate.", evidence_quotes: ["Candidate facts: willing_to_relocate = true"] };
  if (place && home && facts.willing_to_relocate === false) return { status: "not_met", basis: "On-site location differs and candidate will not relocate.", evidence_quotes: [`Candidate facts: location = ${facts.location}`] };
  return { status: "unknown", basis: "Location or relocation not stated.", evidence_quotes: [] };
}

const STATUS_VALUE: Record<MatchStatus, number> = { met: 1, unknown: 0.5, not_met: 0 };

export function scoreFit(jd: StructuredJd, cv: ParsedCv, facts: CandidateFacts, hashes: { jdSnapshot: string; masterCv: string }, now: Date): ScoreSheet {
  const cvYears = experienceYears(cv, now);
  const requirements = [...jd.must_haves, ...jd.nice_to_haves].map((r) => evaluate(r, cv, facts, cvYears, jd));
  const musts = requirements.filter((r) => r.kind === "must");

  const weight = (r: RequirementMatch) => (r.kind === "must" ? 2 : 1);
  const totalWeight = requirements.reduce((sum, r) => sum + weight(r), 0);
  const fit = totalWeight ? Math.round((100 * requirements.reduce((sum, r) => sum + weight(r) * STATUS_VALUE[r.status], 0)) / totalWeight) : 0;

  const mustHaveCoverage = musts.length ? musts.reduce((sum, r) => sum + STATUS_VALUE[r.status], 0) / musts.length : 0;

  // Seniority: explicit years first, then title level.
  let seniority = 0.5;
  if (jd.seniority.min_years !== null && jd.seniority.min_years > 0) seniority = Math.min(1, cvYears / jd.seniority.min_years);
  else if (jd.seniority.level !== "unknown") {
    const order = ["junior", "mid", "senior", "lead"];
    const cvLevel = cvYears >= 8 ? 3 : cvYears >= 5 ? 2 : cvYears >= 2 ? 1 : 0;
    const gap = order.indexOf(jd.seniority.level) - cvLevel;
    seniority = gap <= 0 ? 1 : gap === 1 ? 0.5 : 0;
  }

  const cvDomains = findTerms(DOMAIN_TERMS, cv.text);
  const domainMatch = jd.domains.length ? jd.domains.filter((d) => cvDomains.includes(d)).length / jd.domains.length : 0.5;

  const truth = `${cv.text}\n${factsText(facts)}`;
  const cvKeywords = jd.keywords.filter((term) => textHasTerm(ALL_TERMS, term, truth));
  const atsCoverage = jd.keywords.length ? cvKeywords.length / jd.keywords.length : 0.5;

  const jdTerms = new Set([...jd.keywords, ...requirements.flatMap((r) => r.matched_keywords)]);
  const experience = cv.sections.filter((s) => s.kind === "experience");
  const relevant = experience.filter((s) => s.lines.some((line) => [...jdTerms].some((t) => textHasTerm(ALL_TERMS, t, line))));
  const pool = (relevant.length ? relevant : experience).flatMap((s) => s.lines.filter(isBullet).map(stripBullet));
  const quantified = pool.filter((line) => QUANTIFIED.test(line));
  const impact = Math.min(1, quantified.length / 3);

  const constraintItems = requirements.filter((r) => r.kind === "must" && ["legal", "operational", "language"].includes(r.category));
  const locationItem = (jd.work_mode === "onsite" || jd.work_mode === "hybrid") && jd.location && !constraintItems.some((r) => /(relocat|on[- ]?site|presencial)/i.test(r.text))
    ? locationMatch(jd, facts)
    : null;
  const constraintValues = [...constraintItems.map((r) => STATUS_VALUE[r.status]), ...(locationItem ? [STATUS_VALUE[locationItem.status]] : [])];
  const constraintFit = constraintValues.length ? constraintValues.reduce((a, b) => a + b, 0) / constraintValues.length : 1;

  const blockers = [
    ...constraintItems.filter((r) => r.status === "not_met").map((r) => `Missing ${r.category} must-have: ${r.text}`),
    ...(locationItem?.status === "not_met" ? [`Missing operational must-have: ${locationItem.basis}`] : []),
  ];

  const unverified = [
    ...requirements.filter((r) => r.status === "unknown").map((r) => `${r.text} (${r.basis})`),
    ...(locationItem?.status === "unknown" ? [`Work location ${jd.location} (${locationItem.basis})`] : []),
    ...(jd.domains.length ? [] : ["Posting names no domain terms; domain_match uses neutral 0.5."]),
    ...(jd.keywords.length ? [] : ["Posting names no lexicon keywords; ats_keyword_coverage uses neutral 0.5."]),
    ...(jd.seniority.min_years === null && jd.seniority.level === "unknown" ? ["Posting states no seniority; seniority_match uses neutral 0.5."] : []),
  ];

  return {
    schema: "apply2interview.score_sheet.v1",
    computed_from: "master_cv_and_candidate_facts",
    jd_snapshot_hash: hashes.jdSnapshot,
    master_cv_hash: hashes.masterCv,
    fit_score: {
      value: fit,
      method: "Weighted requirement coverage: must-have weight 2, nice-to-have weight 1; met = 1, unknown = 0.5, not met = 0. Evidence quotes are verbatim master CV lines.",
    },
    requirements,
    facts_used: {
      cv_experience_years: cvYears,
      cv_domains: cvDomains,
      jd_domains: jd.domains,
      jd_keywords: jd.keywords,
      cv_keywords_matched: cvKeywords,
      quantified_bullets: quantified,
    },
    unverified,
    apply_to_interview_pct: applyToInterviewPct({
      must_have_coverage: mustHaveCoverage,
      seniority_match: seniority,
      domain_match: domainMatch,
      impact_evidence: impact,
      ats_keyword_coverage: atsCoverage,
      constraint_fit: constraintFit,
      hard_blockers: blockers,
    }),
  };
}

/** JD terms a CV line touches (used by the section adapter to rank lines). */
export function lineHits(line: string, terms: string[]): number {
  return terms.filter((term) => textHasTerm(ALL_TERMS, term, line)).length;
}

export const INPUT_DEFINITIONS: Record<string, string> = {
  must_have_coverage: "Mean over must-have requirements of met = 1, unknown = 0.5, not met = 0, evaluated against the master CV and candidate facts.",
  seniority_match: "min(1, dated CV years / JD minimum years); else title level vs CV years (same or higher = 1, one level below = 0.5); else neutral 0.5.",
  domain_match: "Share of JD domain terms (logistics, fintech, ...) present in the master CV; neutral 0.5 when the JD names none.",
  impact_evidence: "min(1, quantified bullets / 3) in experience sections the JD touches.",
  ats_keyword_coverage: "Share of JD lexicon keywords present verbatim in the master CV or candidate facts. Never computed on the adapted CV.",
  constraint_fit: "Mean over legal, operational and language must-haves plus on-site location: met = 1, unknown = 0.5, missing = 0; 1 when none.",
  hard_blockers: "Legal or operational must-haves (including required languages) the candidate facts or CV explicitly do not satisfy.",
};
