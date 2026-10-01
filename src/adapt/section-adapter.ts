import { ALL_TERMS, surfaceForm } from "../scoring/lexicon.ts";
import { isBullet, sectionText, type CvSection, type ParsedCv } from "../scoring/cv.ts";
import type { StructuredJd } from "../scoring/jd.ts";
import { lineHits, type ScoreSheet } from "../scoring/score.ts";
import { TEMPLATE_PREFIXES, checkTruth, isTemplateLine } from "./truth-guard.ts";

/**
 * cvs_best_version: a section patch, not a new biography.
 * Only summary, skills, and the 2-4 experience sections the JD touches change,
 * and only by reordering existing lines (plus one summary line that lists terms
 * already in the master CV). Everything else is copied as-is.
 */

export interface SectionPatch {
  section_id: string;
  heading: string | null;
  before: string;
  after: string;
  change: "reordered" | "reordered_and_summary_terms";
  jd_requirements_addressed: string[];
  evidence_quotes: string[];
  invented: false;
}

export interface CvPatch {
  schema: "apply2interview.cv_patch.v1";
  version: number;
  master_cv_hash: string;
  jd_snapshot_hash: string;
  sections: SectionPatch[];
  unchanged_section_ids: string[];
  truth_guard: { passed: true; checked_sections: number };
  derived_from_version: number | null;
  dropped_section_ids: string[];
}

const SPLIT = /\s*([,;|·])\s*/;

function stableSortBy<T>(items: T[], score: (item: T) => number): T[] {
  return items.map((item, index) => ({ item, index, s: score(item) })).sort((a, b) => b.s - a.s || a.index - b.index).map((x) => x.item);
}

function reorderList(line: string, terms: string[]): string {
  const lead = line.match(/^\s*[-–•*·▪]\s+/)?.[0] ?? "";
  const rest = line.slice(lead.length);
  const label = /^([^:,;|·]{1,40}:)\s*(.*)$/.exec(rest);
  const prefix = label ? `${label[1]} ` : "";
  const body = label ? label[2] : rest;
  const separator = SPLIT.exec(body)?.[1];
  if (!separator) return line;
  const items = body.split(SPLIT).filter((_part, index) => index % 2 === 0).map((item) => item.trim()).filter(Boolean);
  const sorted = stableSortBy(items, (item) => lineHits(item, terms));
  const joiner = separator === "," || separator === ";" ? `${separator} ` : ` ${separator} `;
  return `${lead}${prefix}${sorted.join(joiner)}`;
}

function linesWithHits(lines: string[], terms: string[]): number {
  return lines.reduce((sum, line) => sum + lineHits(line, terms), 0);
}

function requirementsAddressed(text: string, score: ScoreSheet): string[] {
  return score.requirements
    .filter((r) => r.matched_keywords.some((term) => lineHits(text, [term]) > 0))
    .map((r) => r.requirement_id);
}

function quotes(lines: string[], terms: string[]): string[] {
  return lines.filter((l) => lineHits(l, terms) > 0 && !isTemplateLine(l)).map((l) => l.replace(/^\s*[-–•*·▪]\s+/, "").trim()).slice(0, 4);
}

function adaptSummary(section: CvSection, terms: string[], cv: ParsedCv): { lines: string[]; addedTerms: boolean } {
  const body = section.lines.filter((l) => l.trim());
  const sentences = body.length === 1 ? body[0].split(/(?<=[.!?])\s+/) : body;
  const sorted = stableSortBy(sentences, (s) => lineHits(s, terms));
  const present = terms
    .map((term) => surfaceForm(ALL_TERMS, term, cv.text))
    .filter((form): form is string => Boolean(form))
    .filter((form, index, all) => all.findIndex((f) => f.toLowerCase() === form.toLowerCase()) === index)
    .slice(0, 6);
  const lines = body.length === 1 ? [sorted.join(" ")] : sorted;
  if (present.length >= 2) {
    const prefix = TEMPLATE_PREFIXES[cv.language] ?? TEMPLATE_PREFIXES.en;
    lines.push(`${prefix} ${present.join(", ")}.`);
    return { lines, addedTerms: true };
  }
  return { lines, addedTerms: false };
}

function adaptBlock(section: CvSection, terms: string[]): string[] {
  // Keep role header lines (title, company, dates) in place; reorder bullets by JD relevance.
  const headerEnd = section.lines.findIndex((line) => isBullet(line));
  if (headerEnd === -1) return stableSortBy(section.lines, (l) => lineHits(l, terms));
  const header = section.lines.slice(0, headerEnd);
  const rest = section.lines.slice(headerEnd);
  const bullets = rest.filter((l) => isBullet(l));
  const others = rest.filter((l) => !isBullet(l) && l.trim());
  return [...header, ...stableSortBy(bullets, (l) => lineHits(l, terms)), ...others];
}

function adaptSkills(section: CvSection, terms: string[]): string[] {
  const lines = section.lines.filter((l) => l.trim()).map((line) => reorderList(line, terms));
  return stableSortBy(lines, (l) => lineHits(l, terms));
}

export interface AdaptOptions {
  version?: number;
  derivedFromVersion?: number | null;
  /** Section ids the HumanWorker rejected in a previous version. */
  dropSectionIds?: string[];
  factsText?: string;
  hashes: { masterCv: string; jdSnapshot: string };
}

export function buildCvPatch(cv: ParsedCv, jd: StructuredJd, score: ScoreSheet, options: AdaptOptions): CvPatch {
  const terms = [...new Set([...jd.keywords, ...score.requirements.flatMap((r) => [...r.matched_keywords, ...r.missing_keywords])])];
  const drop = new Set(options.dropSectionIds ?? []);
  const touchedExperience = cv.sections
    .filter((s) => s.kind === "experience")
    .map((s) => ({ s, hits: linesWithHits(s.lines, terms) }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4)
    .map((x) => x.s.id);

  const patches: SectionPatch[] = [];
  for (const section of cv.sections) {
    if (drop.has(section.id)) continue;
    let lines: string[] | null = null;
    let addedTerms = false;
    if (section.kind === "summary") {
      const result = adaptSummary(section, terms, cv);
      lines = result.lines;
      addedTerms = result.addedTerms;
    } else if (section.kind === "skills") {
      lines = adaptSkills(section, terms);
    } else if (section.kind === "experience" && touchedExperience.includes(section.id)) {
      lines = adaptBlock(section, terms);
    }
    if (!lines) continue;
    const before = sectionText(section);
    const after = sectionText({ ...section, lines });
    if (normalize(before) === normalize(after)) continue;
    patches.push({
      section_id: section.id,
      heading: section.heading,
      before,
      after,
      change: addedTerms ? "reordered_and_summary_terms" : "reordered",
      jd_requirements_addressed: requirementsAddressed(after, score),
      evidence_quotes: quotes(lines, terms),
      invented: false,
    });
  }

  // Hard fail on any fact that is not in the master CV or candidate facts.
  checkTruth(patches.map((p) => ({ section_id: p.section_id, after: p.after })), cv.text, options.factsText ?? "");

  return {
    schema: "apply2interview.cv_patch.v1",
    version: options.version ?? 1,
    master_cv_hash: options.hashes.masterCv,
    jd_snapshot_hash: options.hashes.jdSnapshot,
    sections: patches,
    unchanged_section_ids: cv.sections.map((s) => s.id).filter((id) => !patches.some((p) => p.section_id === id)),
    truth_guard: { passed: true, checked_sections: patches.length },
    derived_from_version: options.derivedFromVersion ?? null,
    dropped_section_ids: [...drop],
  };
}

function normalize(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

/** Full CV text with accepted section patches applied; all other sections verbatim. */
export function applyPatch(cv: ParsedCv, patch: CvPatch, acceptedSectionIds: string[]): string {
  const accepted = new Map(patch.sections.filter((p) => acceptedSectionIds.includes(p.section_id)).map((p) => [p.section_id, p.after]));
  return cv.sections.map((section) => accepted.get(section.id) ?? sectionText(section)).join("\n\n");
}

