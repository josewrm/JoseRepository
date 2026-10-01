import type { StructuredJd } from "../scoring/jd.ts";
import type { CandidateFacts } from "../scoring/score.ts";

/** One of the candidate's own CVs. Every source is truth; none is invented. */
export interface SourceCvInput {
  label: string;
  text: string;
}

export function normalizeSources(raw: unknown, single?: string | null): SourceCvInput[] {
  const list = Array.isArray(raw) ? raw : [];
  const sources = list
    .map((item, index) => ({
      label: String((item as any)?.label ?? "").trim().slice(0, 40) || `CV ${index + 1}`,
      text: String((item as any)?.text ?? "").replace(/\r\n/g, "\n").trim(),
    }))
    .filter((s) => s.text.length > 0)
    .slice(0, 3);
  if (!sources.length && single?.trim()) sources.push({ label: "CV 1", text: single.replace(/\r\n/g, "\n").trim() });
  // Unique labels: they name files and evidence refs.
  const seen = new Set<string>();
  for (const source of sources) {
    let label = source.label;
    for (let n = 2; seen.has(label.toLowerCase()); n++) label = `${source.label} ${n}`;
    seen.add(label.toLowerCase());
    source.label = label;
  }
  return sources;
}

const ascii = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

/** CV_<Name>_<Company>_<Title>[_<source>].md — stable, recruiter-readable, filesystem-safe. */
export function cvFilename(parts: { name: string | null; company: string | null; title: string | null; source?: string | null }): string {
  const pieces = ["CV", parts.name, parts.company, parts.title, parts.source].filter((p): p is string => Boolean(p && p.trim())).map(ascii).filter(Boolean);
  return `${pieces.join("_")}.md`;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;
const LINKEDIN = /(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/i;

export interface FormField {
  key: string;
  label: string;
  value: string;
  source: "candidate_facts" | "cv" | "job_posting" | "prepared" | "missing";
}

export interface ApplicationForm {
  schema: "apply2interview.application_form.v1";
  fields: FormField[];
  missing: string[];
}

/**
 * Pre-fills the application form. Values come verbatim from candidate facts,
 * the CV header, or the posting. Unknown values stay empty and are listed as
 * missing; nothing is guessed.
 */
export function fillApplicationForm(input: {
  facts: CandidateFacts;
  cvText: string;
  jd: StructuredJd;
  jobUrl: string;
  cvFile: string;
  coverLetter: string;
  subject: string;
}): ApplicationForm {
  const header = input.cvText.split("\n").slice(0, 8).join("\n");
  const field = (key: string, label: string, ...candidates: [string | null | undefined, FormField["source"]][]): FormField => {
    const found = candidates.find(([value]) => value && String(value).trim());
    return found ? { key, label, value: String(found[0]).trim(), source: found[1] } : { key, label, value: "", source: "missing" };
  };
  const fields: FormField[] = [
    field("full_name", "Nombre completo", [input.facts.name, "candidate_facts"], [header.split("\n")[0]?.replace(/^#+\s*/, ""), "cv"]),
    field("email", "Email", [input.facts.email, "candidate_facts"], [EMAIL.exec(header)?.[0], "cv"]),
    field("phone", "Teléfono", [input.facts.phone, "candidate_facts"], [PHONE.exec(header)?.[1], "cv"]),
    field("location", "Ubicación", [input.facts.location, "candidate_facts"]),
    field("linkedin", "LinkedIn", [input.facts.linkedin, "candidate_facts"], [LINKEDIN.exec(input.cvText)?.[0], "cv"]),
    field("work_authorization", "Permiso de trabajo", [input.facts.visa, "candidate_facts"]),
    field("languages", "Idiomas", [input.facts.languages?.join(", "), "candidate_facts"]),
    field("availability", "Disponibilidad", [input.facts.availability, "candidate_facts"]),
    field("position", "Puesto", [input.jd.title, "job_posting"]),
    field("company", "Empresa", [input.jd.company, "job_posting"]),
    field("job_url", "Enlace de la oferta", [input.jobUrl, "job_posting"]),
    field("recipient", "Enviar a", [input.jd.contact_email, "job_posting"]),
    field("cv_file", "CV adjunto", [input.cvFile, "prepared"]),
    field("subject", "Asunto", [input.subject, "prepared"]),
    field("cover_letter", "Carta / mensaje", [input.coverLetter, "prepared"]),
  ];
  return { schema: "apply2interview.application_form.v1", fields, missing: fields.filter((f) => f.source === "missing").map((f) => f.label) };
}
