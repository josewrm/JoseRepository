/**
 * Spoken or typed commands for the personal assistant (Spanish, Portuguese, English).
 * Pure parsing: the result is an intent the UI or the API then carries out.
 */

export type Intent =
  | { kind: "search"; query: string; location?: string }
  | { kind: "show_jobs" }
  | { kind: "prepare_all" }
  | { kind: "approve_all" }
  | { kind: "status" }
  | { kind: "open"; page: string }
  | { kind: "help" }
  | { kind: "unknown"; text: string };

const PAGES: Record<string, string[]> = {
  empleos: ["empleos", "empregos", "jobs", "grafo", "graph", "ofertas encontradas"],
  asistente: ["asistente", "assistente", "assistant", "inicio", "home", "jarvis"],
  perfil: ["perfil", "profile", "cvs", "currículum", "curriculum"],
  postulaciones: ["postulaciones", "candidaturas", "applications", "sesiones"],
};

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[¿?¡!.,;]+/g, " ").replace(/\s+/g, " ").trim();

export function parseCommand(raw: string): Intent {
  const text = strip(raw);
  if (!text) return { kind: "help" };

  const search = /^(?:jarvis\s+)?(?:busca(?:r|me)?|procura(?:r)?|pesquisa(?:r)?|search(?: for)?|find|encuentra(?:me)?)\s+(?:empleos?\s+(?:de\s+)?|empregos?\s+(?:de\s+)?|jobs?\s+(?:for\s+)?|trabajos?\s+(?:de\s+)?|vagas?\s+(?:de\s+)?)?(.+?)(?:\s+(?:en|em|in|no|na)\s+(.+))?$/.exec(text);
  if (search) {
    const query = search[1].trim();
    const location = search[2]?.trim();
    // Keep the speaker's casing where possible.
    return { kind: "search", query: recase(raw, query), ...(location ? { location: recase(raw, location) } : {}) };
  }
  if (/\b(aproba(?:r)?|aprova(?:r)?|approve|envia(?:r)?|enviar todos|send all|easy apply)\b/.test(text)) return { kind: "approve_all" };
  if (/\b(prepara(?:r)?|adapta(?:r)?|prepare|adapt)\b/.test(text)) return { kind: "prepare_all" };
  if (/\b(estado|status|resumen|resumo|como va|como vamos|summary)\b/.test(text)) return { kind: "status" };
  if (/\b(ayuda|ajuda|help|que puedes)\b/.test(text)) return { kind: "help" };
  const open = /^(?:jarvis\s+)?(?:abre|abrir|abra|muestra(?:me)?|mostra(?:r)?|ver|open|show|ir a|vai para|go to)\s+(?:el |la |los |las |o |a |os |as |the |my |mis |meus )?(.+)$/.exec(text);
  const target = open ? open[1] : text;
  for (const [page, words] of Object.entries(PAGES)) {
    if (words.some((w) => target === strip(w) || target.startsWith(`${strip(w)} `) || (open && target.includes(strip(w))))) {
      return page === "empleos" ? { kind: "show_jobs" } : { kind: "open", page };
    }
  }
  return { kind: "unknown", text: raw.trim() };
}

/** Find `lower` (accent-stripped) in the original text and return it with its original casing. */
function recase(original: string, lower: string): string {
  const words = original.trim().split(/\s+/);
  const stripped = words.map(strip);
  const target = lower.split(" ");
  for (let i = 0; i + target.length <= stripped.length; i++) {
    if (target.every((w, j) => stripped[i + j] === w)) return words.slice(i, i + target.length).join(" ").replace(/[¿?¡!.,;]+$/g, "");
  }
  return lower;
}
