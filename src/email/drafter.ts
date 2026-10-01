import type { StructuredJd } from "../scoring/jd.ts";
import type { ScoreSheet, CandidateFacts } from "../scoring/score.ts";

/**
 * Application email draft, in the posting language. Draft only: sending is a
 * Request, and the host never sends on its own. The draft never contains the
 * fit score, the percentage, or scoring vocabulary.
 */

export interface EmailDraft {
  schema: "apply2interview.email_draft.v1";
  language: string;
  to: string | null;
  subject: string;
  body: string;
  highlights_source: "verbatim_master_cv_lines";
  status: "draft";
}

interface Template {
  subject: (title: string) => string;
  greeting: (company: string | null) => string;
  opening: (title: string, company: string | null) => string;
  highlightsIntro: string;
  closing: string;
  signoff: string;
}

const TEMPLATES: Record<string, Template> = {
  en: {
    subject: (t) => `Application: ${t}`,
    greeting: (c) => (c ? `Dear ${c} hiring team,` : "Dear hiring team,"),
    opening: (t, c) => `I am applying for the ${t} position${c ? ` at ${c}` : ""}.`,
    highlightsIntro: "A few points from my CV that relate to the role:",
    closing: "My CV is attached. I would welcome the chance to discuss the role.",
    signoff: "Kind regards,",
  },
  es: {
    subject: (t) => `Candidatura: ${t}`,
    greeting: (c) => (c ? `Estimado equipo de selección de ${c}:` : "Estimado equipo de selección:"),
    opening: (t, c) => `Les escribo para presentar mi candidatura al puesto de ${t}${c ? ` en ${c}` : ""}.`,
    highlightsIntro: "Algunos puntos de mi CV relacionados con el puesto:",
    closing: "Adjunto mi CV. Quedo a su disposición para conversar sobre el puesto.",
    signoff: "Un saludo cordial,",
  },
  de: {
    subject: (t) => `Bewerbung: ${t}`,
    greeting: (c) => (c ? `Sehr geehrtes Recruiting-Team von ${c},` : "Sehr geehrte Damen und Herren,"),
    opening: (t, c) => `hiermit bewerbe ich mich auf die Position ${t}${c ? ` bei ${c}` : ""}.`,
    highlightsIntro: "Einige Punkte aus meinem Lebenslauf mit Bezug zur Stelle:",
    closing: "Meinen Lebenslauf finden Sie im Anhang. Über ein Gespräch würde ich mich freuen.",
    signoff: "Mit freundlichen Grüßen",
  },
  fr: {
    subject: (t) => `Candidature : ${t}`,
    greeting: () => "Madame, Monsieur,",
    opening: (t, c) => `Je vous adresse ma candidature au poste de ${t}${c ? ` chez ${c}` : ""}.`,
    highlightsIntro: "Quelques éléments de mon CV en lien avec le poste :",
    closing: "Vous trouverez mon CV en pièce jointe. Je serais ravi(e) d'échanger sur ce poste.",
    signoff: "Cordialement,",
  },
  pt: {
    subject: (t) => `Candidatura: ${t}`,
    greeting: (c) => (c ? `Prezada equipe de recrutamento da ${c},` : "Prezada equipe de recrutamento,"),
    opening: (t, c) => `Venho apresentar minha candidatura para a vaga de ${t}${c ? ` na ${c}` : ""}.`,
    highlightsIntro: "Alguns pontos do meu currículo relacionados à vaga:",
    closing: "Meu currículo segue em anexo. Fico à disposição para conversarmos.",
    signoff: "Atenciosamente,",
  },
  it: {
    subject: (t) => `Candidatura: ${t}`,
    greeting: (c) => (c ? `Gentile team di selezione di ${c},` : "Gentile team di selezione,"),
    opening: (t, c) => `Vi scrivo per candidarmi alla posizione di ${t}${c ? ` presso ${c}` : ""}.`,
    highlightsIntro: "Alcuni punti del mio CV legati al ruolo:",
    closing: "In allegato il mio CV. Sarei lieto/a di approfondire il ruolo in un colloquio.",
    signoff: "Cordiali saluti,",
  },
};

const SCORE_WORDS = /\b(score|scoring|fit score|percentage|heuristic|apply_to_interview|match rate|puntuaci[oó]n|porcentaje|prozent|bewertung|pourcentage|pontua[çc][ãa]o|porcentagem|punteggio|percentuale)\b/i;

export class EmailGuardError extends Error {}

export function draftEmail(jd: StructuredJd, score: ScoreSheet | null, facts: CandidateFacts, cvHeaderName: string | null): EmailDraft {
  const language = TEMPLATES[jd.language] ? jd.language : "en";
  const t = TEMPLATES[language];
  const title = jd.title ?? (language === "en" ? "the advertised role" : jd.title ?? "—");
  const highlights = score
    ? [...new Set(score.requirements.filter((r) => r.kind === "must" && r.status === "met").flatMap((r) => r.evidence_quotes))]
        .filter((q) => !q.startsWith("Candidate facts:"))
        .slice(0, 3)
    : [];
  const name = facts.name?.trim() || cvHeaderName || "[Your name]";
  const parts = [t.greeting(jd.company), "", t.opening(title, jd.company)];
  if (highlights.length) parts.push("", t.highlightsIntro, ...highlights.map((h) => `- ${h}`));
  parts.push("", t.closing, "", t.signoff, name);
  const draft: EmailDraft = {
    schema: "apply2interview.email_draft.v1",
    language,
    to: jd.contact_email,
    subject: t.subject(title),
    body: parts.join("\n"),
    highlights_source: "verbatim_master_cv_lines",
    status: "draft",
  };
  assertNoScore(draft, score);
  return draft;
}

/** The email never carries the fit score, the percentage, or scoring words. */
export function assertNoScore(draft: { subject: string; body: string }, score: ScoreSheet | null): void {
  const text = `${draft.subject}\n${draft.body}`;
  if (SCORE_WORDS.test(text)) throw new EmailGuardError("Email draft contains scoring vocabulary.");
  if (!score) return;
  const numbers = [score.fit_score.value, score.apply_to_interview_pct.value];
  const quoted = new Set(score.requirements.flatMap((r) => r.evidence_quotes).join("\n").match(/\d+\s?%/g) ?? []);
  for (const n of numbers) {
    const pattern = new RegExp(`(^|[^\\d])${n}\\s?(%|/100|\\s?percent|\\s?por ?ciento|\\s?prozent)`, "i");
    const hit = pattern.exec(text);
    if (hit && !quoted.has(`${n}%`) && !quoted.has(`${n} %`)) throw new EmailGuardError("Email draft contains the fit score or percentage.");
  }
}

/** First header line that looks like a person's name (no digits, @, or URLs). */
export function nameFromCvHeader(headerLines: string[]): string | null {
  const line = headerLines.map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 0);
  if (!line || line.length > 60 || /[\d@/:]/.test(line) || line.split(/\s+/).length > 5) return null;
  return line;
}
