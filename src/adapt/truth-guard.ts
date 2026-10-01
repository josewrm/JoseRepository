/**
 * Truth guard. Hard-fails when an adapted section contains a fact that is not
 * in the master CV or candidate facts: employers, titles, tools,
 * certifications, numbers, dates, metrics. It checks every token, and every
 * non-template line must already exist verbatim in the master CV.
 */

export class TruthGuardError extends Error {
  violations: { section_id: string; token?: string; line?: string; reason: string }[];
  constructor(violations: TruthGuardError["violations"]) {
    super(`cvs_best_version rejected: ${violations.map((v) => `${v.section_id}: ${v.reason}`).join("; ")}`);
    this.name = "TruthGuardError";
    this.violations = violations;
  }
}

/** Fixed template prefixes the adapter may add. Their words carry no CV facts. */
export const TEMPLATE_PREFIXES: Record<string, string> = {
  en: "Relevant to this role:",
  es: "Relevante para este puesto:",
  de: "Relevant für diese Rolle:",
  fr: "Pertinent pour ce poste :",
  pt: "Relevante para esta vaga:",
  it: "Rilevante per questo ruolo:",
};

/** Prefix for a skills line listing terms from the candidate's other source CVs. */
export const SKILL_TEMPLATE_PREFIXES: Record<string, string> = {
  en: "Also:",
  es: "También:",
  de: "Außerdem:",
  fr: "Également :",
  pt: "Também:",
  it: "Inoltre:",
};

const ALL_PREFIXES = [...Object.values(TEMPLATE_PREFIXES), ...Object.values(SKILL_TEMPLATE_PREFIXES)];

const TEMPLATE_WORDS = new Set(ALL_PREFIXES.flatMap((prefix) => tokens(prefix)));

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#./%'’-]*/gu) ?? [])
    .map((token) => token.replace(/[.,;:'’-]+$/g, ""))
    .filter(Boolean);
}

function normalizeLine(line: string): string {
  return line.replace(/^\s*[-–•*·▪]\s+/, "").replace(/\s+/g, " ").trim();
}

export function isTemplateLine(line: string): boolean {
  const clean = normalizeLine(line);
  return ALL_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

const SEPARATOR = /[,;|·]/;

/** Order-independent key of a separated list line, keeping any "Label:" prefix fixed. */
export function itemSetKey(line: string): string {
  const match = /^([^:,;|·]{1,40}:)\s*(.*)$/.exec(line);
  const label = match ? match[1].toLowerCase() : "";
  const body = match ? match[2] : line;
  return `${label}${body.split(SEPARATOR).map((i) => i.trim().toLowerCase()).filter(Boolean).sort().join("\u0001")}`;
}

export function sentenceSetKey(line: string): string {
  return line.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean).sort().join("\u0001");
}

export interface GuardInput {
  section_id: string;
  after: string;
}

/**
 * `lineCheck: false` is used for HumanWorker takeover edits: rewording is
 * allowed, new facts (tokens) are not.
 */
export function checkTruth(
  patches: GuardInput[],
  masterCv: string,
  factsText: string,
  options: {
    lineCheck?: boolean;
    /** Per-section allowed lines: a role keeps only its own bullets (no moving achievements between employers). */
    sectionLines?: Record<string, string[]>;
  } = {},
): void {
  const lineCheck = options.lineCheck !== false;
  const allowed = new Set([...tokens(masterCv), ...tokens(factsText)]);
  const masterLines = new Set(masterCv.split("\n").map(normalizeLine).filter(Boolean));
  // A skills line may be a reordering of the items of one master line.
  const masterItemSets = new Set([...masterLines].filter((l) => SEPARATOR.test(l)).map(itemSetKey));
  // A summary line may be a reordering of the sentences of one master line.
  const masterSentenceSets = new Set([...masterLines].map(sentenceSetKey));
  const violations: TruthGuardError["violations"] = [];
  for (const patch of patches) {
    for (const token of tokens(patch.after)) {
      if (!allowed.has(token) && !TEMPLATE_WORDS.has(token)) {
        violations.push({ section_id: patch.section_id, token, reason: `adds "${token}", which is not in the master CV or candidate facts` });
      }
    }
    if (!lineCheck) continue;
    for (const line of patch.after.split("\n")) {
      const clean = normalizeLine(line);
      if (!clean) continue;
      if (isTemplateLine(line)) {
        // Template lines list CV terms only: each item verbatim in the master CV, no counts or durations.
        const prefix = ALL_PREFIXES.find((p) => clean.startsWith(p))!;
        const items = clean.slice(prefix.length).replace(/\.$/, "").split(",").map((item) => item.trim()).filter(Boolean);
        for (const item of items) {
          if (/^\d/.test(item) || /\b(years?|yrs|años|jahre|ans)\b/i.test(item) || !masterCv.toLowerCase().includes(item.toLowerCase())) {
            violations.push({ section_id: patch.section_id, line: clean, reason: `summary term "${item}" is not a verbatim master CV term` });
          }
        }
        continue;
      }
      if (!masterLines.has(clean) && !masterItemSets.has(itemSetKey(clean)) && !masterSentenceSets.has(sentenceSetKey(clean))) {
        violations.push({ section_id: patch.section_id, line: clean, reason: `line "${clean.slice(0, 80)}" does not exist in the master CV` });
        continue;
      }
      const own = options.sectionLines?.[patch.section_id];
      if (own && !own.map(normalizeLine).includes(clean)) {
        violations.push({ section_id: patch.section_id, line: clean, reason: `line "${clean.slice(0, 80)}" belongs to a different role` });
      }
    }
  }
  if (violations.length) throw new TruthGuardError(violations);
}
