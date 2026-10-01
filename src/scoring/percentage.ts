/**
 * apply_to_interview_pct, heuristic_v1. Computed, never "felt" by a model.
 * It is a heuristic, not a promise.
 */

export interface PercentageInputs {
  must_have_coverage: number;
  seniority_match: number;
  domain_match: number;
  impact_evidence: number;
  ats_keyword_coverage: number;
  constraint_fit: number;
  hard_blockers: string[];
}

export const WEIGHTS = {
  base: 8,
  must_have_coverage: 28,
  seniority_match: 12,
  domain_match: 12,
  impact_evidence: 10,
  ats_keyword_coverage: 8,
  constraint_fit: 12,
  hard_blocker_penalty: 51,
  blocker_cap: 49,
} as const;

export const FORMULA_TEXT = [
  "base = 8",
  "+ must_have_coverage * 28",
  "+ seniority_match * 12",
  "+ domain_match * 12",
  "+ impact_evidence * 10",
  "+ ats_keyword_coverage * 8",
  "+ constraint_fit * 12",
  "- 51 if any hard blocker, else 0",
  "clamp 0..100; cap 49 when a legal or operational must-have is missing",
].join("\n");

export type Band = "strong" | "solid" | "stretch" | "weak_or_blocked";

export interface PercentageResult {
  label: "heuristic_v1";
  value: number;
  raw: number;
  band: Band;
  formula: string;
  terms: Record<string, number>;
  inputs: PercentageInputs;
  disclaimer: string;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const round2 = (value: number) => Math.round(value * 100) / 100;

export function band(value: number): Band {
  if (value >= 70) return "strong";
  if (value >= 50) return "solid";
  if (value >= 30) return "stretch";
  return "weak_or_blocked";
}

export function applyToInterviewPct(input: PercentageInputs): PercentageResult {
  const inputs: PercentageInputs = {
    must_have_coverage: round2(clamp01(input.must_have_coverage)),
    seniority_match: round2(clamp01(input.seniority_match)),
    domain_match: round2(clamp01(input.domain_match)),
    impact_evidence: round2(clamp01(input.impact_evidence)),
    ats_keyword_coverage: round2(clamp01(input.ats_keyword_coverage)),
    constraint_fit: round2(clamp01(input.constraint_fit)),
    hard_blockers: [...input.hard_blockers],
  };
  const terms = {
    base: WEIGHTS.base,
    must_have_coverage: round2(inputs.must_have_coverage * WEIGHTS.must_have_coverage),
    seniority_match: round2(inputs.seniority_match * WEIGHTS.seniority_match),
    domain_match: round2(inputs.domain_match * WEIGHTS.domain_match),
    impact_evidence: round2(inputs.impact_evidence * WEIGHTS.impact_evidence),
    ats_keyword_coverage: round2(inputs.ats_keyword_coverage * WEIGHTS.ats_keyword_coverage),
    constraint_fit: round2(inputs.constraint_fit * WEIGHTS.constraint_fit),
    hard_blocker_penalty: inputs.hard_blockers.length ? -WEIGHTS.hard_blocker_penalty : 0,
  };
  const raw = round2(Object.values(terms).reduce((sum, term) => sum + term, 0));
  let value = Math.round(Math.min(100, Math.max(0, raw)));
  if (inputs.hard_blockers.length) value = Math.min(value, WEIGHTS.blocker_cap);
  return {
    label: "heuristic_v1",
    value,
    raw,
    band: band(value),
    formula: FORMULA_TEXT,
    terms,
    inputs,
    disclaimer: "Heuristic estimate of reaching an interview if you apply. Not a promise and not a model judgment.",
  };
}
