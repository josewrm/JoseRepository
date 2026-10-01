import { ALL_TERMS, surfaceForm, textHasTerm } from "../scoring/lexicon.ts";
import { DATE_RANGE, isBullet, sectionText, type CvSection, type ParsedCv } from "../scoring/cv.ts";
import type { StructuredJd } from "../scoring/jd.ts";
import { lineHits, type ScoreSheet } from "../scoring/score.ts";
import { SKILL_TEMPLATE_PREFIXES, TEMPLATE_PREFIXES, checkTruth, isTemplateLine } from "./truth-guard.ts";

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
  change: "reordered" | "reordered_and_summary_terms" | "enriched_from_source_cvs";
  /** Labels of the candidate's other source CVs whose lines were used here. */
  sources_used: string[];
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
  source_label: string;
}

/** Another of the candidate's own CVs. Its lines are facts too, but stay with their own role. */
export interface SourceCv {
  label: string;
  cv: ParsedCv;
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

function adaptSummary(section: CvSection, terms: string[], cv: ParsedCv, unionText: string): { lines: string[]; addedTerms: boolean } {
  const body = section.lines.filter((l) => l.trim());
  const sentences = body.length === 1 ? body[0].split(/(?<=[.!?])\s+/) : body;
  const sorted = stableSortBy(sentences, (s) => lineHits(s, terms));
  const present = terms
    .map((term) => surfaceForm(ALL_TERMS, term, cv.text) ?? surfaceForm(ALL_TERMS, term, unionText))
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

function adaptSkills(section: CvSection, terms: string[], cv: ParsedCv, others: SourceCv[]): { lines: string[]; used: string[] } {
  const lines = stableSortBy(section.lines.filter((l) => l.trim()).map((line) => reorderList(line, terms)), (l) => lineHits(l, terms));
  // JD terms listed in the skills of the candidate's other CVs but missing here.
  const added: string[] = [];
  const used = new Set<string>();
  for (const term of terms) {
    if (textHasTerm(ALL_TERMS, term, cv.text)) continue;
    for (const other of others) {
      const skillsText = other.cv.sections.filter((s) => s.kind === "skills").map(sectionText).join("\n");
      const form = surfaceForm(ALL_TERMS, term, skillsText);
      if (form && !added.some((a) => a.toLowerCase() === form.toLowerCase())) {
        added.push(form);
        used.add(other.label);
        break;
      }
    }
  }
  if (added.length) lines.push(`${SKILL_TEMPLATE_PREFIXES[cv.language] ?? SKILL_TEMPLATE_PREFIXES.en} ${added.join(", ")}.`);
  return { lines, used: [...used] };
}

/** Same role in another CV: same dated range and at least one shared name token in the role header. */
function roleKey(section: CvSection): { range: string; names: Set<string> } | null {
  const header = section.lines.filter((l) => !isBullet(l) && l.trim());
  const dated = header.find((l) => DATE_RANGE.test(l));
  if (!dated) return null;
  const range = DATE_RANGE.exec(dated)![0].toLowerCase().replace(/\s+/g, "").replace(/[–—]/g, "-");
  const names = new Set(header.join(" ").match(/\p{Lu}[\p{L}&.-]{3,}/gu) ?? []);
  return { range, names };
}

function matchingRoleLines(section: CvSection, cv: ParsedCv, others: SourceCv[]): { lines: string[]; label: string }[] {
  const key = roleKey(section);
  if (!key) return [];
  const out: { lines: string[]; label: string }[] = [];
  for (const other of others) {
    if (other.cv.language !== cv.language) continue; // keep one language per CV
    for (const candidate of other.cv.sections.filter((s) => s.kind === "experience")) {
      const k = roleKey(candidate);
      if (k && k.range === key.range && [...k.names].some((n) => key.names.has(n))) {
        out.push({ lines: candidate.lines.filter(isBullet), label: other.label });
      }
    }
  }
  return out;
}

export interface AdaptOptions {
  version?: number;
  derivedFromVersion?: number | null;
  /** Section ids the HumanWorker rejected in a previous version. */
  dropSectionIds?: string[];
  factsText?: string;
  hashes: { masterCv: string; jdSnapshot: string };
  /** The candidate's other source CVs. */
  otherSources?: SourceCv[];
  sourceLabel?: string;
}

export function buildCvPatch(cv: ParsedCv, jd: StructuredJd, score: ScoreSheet, options: AdaptOptions): CvPatch {
  const terms = [...new Set([...jd.keywords, ...score.requirements.flatMap((r) => [...r.matched_keywords, ...r.missing_keywords])])];
  const drop = new Set(options.dropSectionIds ?? []);
  const others = options.otherSources ?? [];
  const unionText = [cv.text, ...others.map((o) => o.cv.text)].join("\n");
  const norm = (l: string) => l.replace(/^\s*[-–•*·▪]\s+/, "").replace(/\s+/g, " ").trim();
  const sectionLines: Record<string, string[]> = {};
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
    let used: string[] = [];
    if (section.kind === "summary") {
      const result = adaptSummary(section, terms, cv, unionText);
      lines = result.lines;
      addedTerms = result.addedTerms;
    } else if (section.kind === "skills") {
      const result = adaptSkills(section, terms, cv, others);
      lines = result.lines;
      used = result.used;
    } else if (section.kind === "experience") {
      // Bullets for this same role from the candidate's other CVs (same language) that the JD touches.
      const matches = matchingRoleLines(section, cv, others);
      const have = new Set(section.lines.map(norm));
      const extra: string[] = [];
      for (const match of matches) {
        for (const line of match.lines) {
          if (!have.has(norm(line)) && lineHits(line, terms) > 0) {
            have.add(norm(line));
            extra.push(line);
            if (!used.includes(match.label)) used.push(match.label);
          }
        }
      }
      sectionLines[section.id] = [...section.lines, ...matches.flatMap((m) => m.lines)];
      if (extra.length || touchedExperience.includes(section.id)) {
        lines = adaptBlock({ ...section, lines: [...section.lines, ...extra] }, terms);
      }
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
      change: used.length ? "enriched_from_source_cvs" : addedTerms ? "reordered_and_summary_terms" : "reordered",
      sources_used: used,
      jd_requirements_addressed: requirementsAddressed(after, score),
      evidence_quotes: quotes(lines, terms),
      invented: false,
    });
  }

  // Hard fail on any fact that is not in the master CV or candidate facts.
  checkTruth(patches.map((p) => ({ section_id: p.section_id, after: p.after })), unionText, options.factsText ?? "", { sectionLines });

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
    source_label: options.sourceLabel ?? "master",
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

