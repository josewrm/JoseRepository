import type { HostStore } from "../store/host-store.ts";
import { searchJobs, type JobCard, type SearchParams } from "../adapters/job-search.ts";
import { ALL_TERMS, DOMAIN_TERMS, findTerms } from "../scoring/lexicon.ts";
import { normalizeSources, type SourceCvInput } from "./application-package.ts";
import { Apply2InterviewService, UserError, normalizeFacts } from "./service.ts";
import type { CandidateFacts } from "../scoring/score.ts";
import { parseCommand, type Intent } from "./commands.ts";

/**
 * Personal assistant layer: the candidate profile, jobs found, and batch
 * actions over them. Each job is its own WorkSession in the protocol store.
 * The assistant prepares and asks; the HumanWorker approves with one tap and
 * submits on the job site themselves. It never submits to LinkedIn or an ATS.
 */

export interface Profile {
  sources: SourceCvInput[];
  facts: CandidateFacts;
  search: SearchParams;
}

export type LeadStatus = "found" | "needs_jd" | "prepared" | "approved" | "submitted" | "failed";

export interface JobLead extends JobCard {
  found_at: string;
  query: string;
  relevance: number;
  matched_terms: string[];
  status: LeadStatus;
  ws_id?: string;
  pct?: number | null;
  best_label?: string | null;
  note?: string;
  example?: boolean;
}

const MAX_BATCH = 15;

export class Assistant {
  hosts: HostStore;
  service: Apply2InterviewService;
  fetchImpl: typeof fetch;
  /** Leads injected when no live search is possible (browser edition). */
  exampleLeads: JobCard[];

  constructor(hosts: HostStore, service: Apply2InterviewService, options: { fetchImpl?: typeof fetch; exampleLeads?: JobCard[] } = {}) {
    this.hosts = hosts;
    this.service = service;
    this.fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.exampleLeads = options.exampleLeads ?? [];
  }

  // ------------------------------------------------------------ profile

  profile(): Profile {
    return this.hosts.getProfile<Profile>() ?? { sources: [], facts: {}, search: { query: "", location: "" } };
  }

  saveProfile(input: { source_cvs?: unknown; candidate_facts?: Record<string, unknown>; search?: Partial<SearchParams> }): Profile {
    const current = this.profile();
    const next: Profile = {
      sources: input.source_cvs !== undefined ? normalizeSources(input.source_cvs) : current.sources,
      facts: input.candidate_facts ? normalizeFacts(input.candidate_facts) : current.facts,
      search: { ...current.search, ...cleanSearch(input.search ?? {}) },
    };
    this.hosts.saveProfile(next);
    return next;
  }

  /** Skill and domain terms in the candidate's own CVs; relevance is measured against these. */
  profileTerms(): string[] {
    const text = this.profile().sources.map((s) => s.text).join("\n");
    return [...new Set([...findTerms(ALL_TERMS, text), ...findTerms(DOMAIN_TERMS, text)])];
  }

  // ------------------------------------------------------------- search

  async search(input: Partial<SearchParams> = {}): Promise<JobLead[]> {
    const params = { ...this.profile().search, ...cleanSearch(input) };
    if (!params.query) throw new UserError("Dime qué buscar, por ejemplo: «buscar SAP EWM en Madrid».");
    let cards: JobCard[];
    let example = false;
    try {
      cards = await searchJobs(params, this.fetchImpl);
    } catch (error) {
      if (!this.exampleLeads.length) throw new UserError(`No se pudo buscar en LinkedIn: ${(error as Error).message}`, 502);
      cards = this.exampleLeads;
      example = true;
    }
    this.saveProfile({ search: params });
    const terms = this.profileTerms();
    const now = new Date().toISOString();
    for (const card of cards) {
      const existing = this.hosts.getLead<JobLead>(card.id);
      const matched = terms.filter((t) => findTerms({ [t]: ALL_TERMS[t] ?? DOMAIN_TERMS[t] ?? [t] }, `${card.title} ${card.company ?? ""}`).length);
      const queryHit = params.query.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && card.title.toLowerCase().includes(w)).length;
      const relevance = Math.min(100, matched.length * 25 + queryHit * 15);
      this.hosts.saveLead({
        ...card,
        found_at: existing?.found_at ?? now,
        query: params.query,
        relevance: existing?.pct != null ? existing.relevance : relevance,
        matched_terms: matched,
        status: existing?.status ?? "found",
        ...(existing?.ws_id ? { ws_id: existing.ws_id, pct: existing.pct, best_label: existing.best_label } : {}),
        ...(example ? { example: true, note: "Ejemplo: la búsqueda en vivo solo funciona en la versión con servidor." } : {}),
      } as JobLead);
    }
    return this.leads();
  }

  leads(): JobLead[] {
    const leads = this.hosts.listLeads<JobLead>().map((lead) => this.refresh(lead));
    return leads.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.relevance - a.relevance);
  }

  /** Pull the lead's status from its WorkSession. */
  private refresh(lead: JobLead): JobLead {
    if (!lead.ws_id) return lead;
    const view = this.service.view(lead.ws_id);
    const pending = this.service.pendingRequests(lead.ws_id);
    const needsJd = pending.some((r) => r.requested_action.action === "use_human_supplied_jd");
    const status: LeadStatus = view.external_submission
      ? "submitted"
      : view.artifacts.accepted_cv
        ? "approved"
        : needsJd
          ? "needs_jd"
          : view.evaluation
            ? "prepared"
            : "failed";
    const best = view.evaluation?.sources?.find((s: any) => s.label === view.evaluation.best_label);
    const next = { ...lead, status, pct: best?.after?.pct ?? view.artifacts.score_sheet?.apply_to_interview_pct?.value ?? null, best_label: view.evaluation?.best_label ?? null };
    if (next.status !== lead.status || next.pct !== lead.pct) this.hosts.saveLead(next);
    return next;
  }

  // -------------------------------------------------------------- batch

  /** Opens one WorkSession per job: full JD, three CVs adapted and evaluated, form filled. */
  async prepare(ids?: string[]): Promise<JobLead[]> {
    const profile = this.profile();
    if (!profile.sources.length) throw new UserError("Primero guarda tus CVs en el perfil.", 409);
    const targets = this.pick(ids, (l) => !l.ws_id).slice(0, MAX_BATCH);
    for (const lead of targets) {
      try {
        const wsId = await this.service.startSession({ job_url: lead.url, source_cvs: profile.sources, candidate_facts: profile.facts as Record<string, unknown> });
        this.hosts.saveLead({ ...lead, ws_id: wsId });
      } catch (error) {
        this.hosts.saveLead({ ...lead, status: "failed", note: (error as Error).message.slice(0, 200) });
      }
    }
    return this.leads();
  }

  /**
   * One tap from the HumanWorker: one approve Review per pending CV Request.
   * Returns the job links for the human to open and submit; nothing is submitted here.
   */
  async approveAll(ids?: string[]): Promise<{ leads: JobLead[]; to_open: { id: string; title: string; url: string }[] }> {
    const targets = this.pick(ids, (l) => l.status === "prepared" || l.status === "approved");
    for (const lead of targets.filter((l) => l.status === "prepared")) {
      const request = this.service.pendingRequests(lead.ws_id!).find((r) => r.requested_action.action === "accept_cv_version");
      if (request) await this.service.review(lead.ws_id!, request.id, { decision: "approve", comments: "Aprobado en lote desde el asistente (un toque)." });
    }
    const leads = this.leads();
    const approved = leads.filter((l) => targets.some((t) => t.id === l.id) && l.status === "approved");
    return { leads, to_open: approved.map((l) => ({ id: l.id, title: l.title, url: l.url })) };
  }

  markSubmitted(id: string): JobLead {
    const lead = this.hosts.getLead<JobLead>(id);
    if (!lead?.ws_id) throw new UserError("Ese empleo no está preparado.", 404);
    this.service.markSubmittedExternally(lead.ws_id, new URL(lead.url).hostname);
    return this.refresh(lead);
  }

  private pick(ids: string[] | undefined, filter: (lead: JobLead) => boolean): JobLead[] {
    const all = this.leads();
    const chosen = ids?.length ? all.filter((l) => ids.includes(l.id)) : all;
    return chosen.filter(filter);
  }

  /** Carries out a spoken or typed command and answers in one short sentence. */
  async command(text: string): Promise<{ intent: Intent; reply: string; page?: string; to_open?: { id: string; title: string; url: string }[] }> {
    const intent = parseCommand(text);
    switch (intent.kind) {
      case "search": {
        const leads = await this.search({ query: intent.query, ...(intent.location ? { location: intent.location } : {}) });
        const fresh = leads.filter((l) => l.query === intent.query);
        const example = fresh.some((l) => l.example) ? " (ejemplos: sin servidor no hay búsqueda en vivo)" : "";
        return { intent, page: "empleos", reply: `Encontré ${fresh.length} empleos de ${intent.query}${intent.location ? ` en ${intent.location}` : ""}${example}. ¿Los preparo todos?` };
      }
      case "show_jobs":
        return { intent, page: "empleos", reply: `Tienes ${this.leads().length} empleos en el grafo.` };
      case "prepare_all": {
        const leads = await this.prepare();
        const ready = leads.filter((l) => l.status === "prepared");
        const best = ready.reduce<number | null>((m, l) => (l.pct != null && (m == null || l.pct > m) ? l.pct : m), null);
        const needs = leads.filter((l) => l.status === "needs_jd").length;
        return { intent, page: "empleos", reply: `Preparados ${ready.length}${best != null ? `; el mejor llega a ${best}%` : ""}.${needs ? ` ${needs} necesitan que pegues la oferta.` : ""} Di «aprobar todos» cuando quieras.` };
      }
      case "approve_all": {
        const result = await this.approveAll();
        return { intent, page: "empleos", to_open: result.to_open, reply: result.to_open.length ? `Aprobados ${result.to_open.length} CVs. Abro cada oferta para que pulses Easy Apply tú; yo no envío en LinkedIn.` : "No hay nada preparado para aprobar." };
      }
      case "status": {
        const s = this.summary();
        return { intent, reply: `${s.total} empleos: ${s.prepared} preparados, ${s.approved} aprobados, ${s.submitted} enviados por ti.${s.best_pct != null ? ` Mejor ${s.best_pct}%.` : ""}` };
      }
      case "open":
        return { intent, page: intent.page, reply: `Abriendo ${intent.page}.` };
      case "help":
        return { intent, reply: "Prueba: «busca SAP EWM en Madrid», «prepara todos», «aprobar todos», «estado» o «abre empleos»." };
      default:
        return { intent, reply: `No entendí «${intent.text}». Di «ayuda» para ver ejemplos.` };
    }
  }

  summary() {
    const leads = this.leads();
    const count = (s: LeadStatus) => leads.filter((l) => l.status === s).length;
    const pcts = leads.map((l) => l.pct).filter((p): p is number => typeof p === "number");
    return {
      total: leads.length,
      found: count("found"),
      prepared: count("prepared"),
      needs_jd: count("needs_jd"),
      approved: count("approved"),
      submitted: count("submitted"),
      failed: count("failed"),
      best_pct: pcts.length ? Math.max(...pcts) : null,
      avg_pct: pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null,
      has_profile: this.profile().sources.length > 0,
    };
  }
}

function cleanSearch(raw: Partial<SearchParams>): Partial<SearchParams> {
  const out: Partial<SearchParams> = {};
  if (typeof raw.query === "string" && raw.query.trim()) out.query = raw.query.trim().slice(0, 120);
  if (typeof raw.location === "string" && raw.location.trim()) out.location = raw.location.trim().slice(0, 80);
  if (typeof raw.jobage === "number" && raw.jobage > 0) out.jobage = Math.min(30, Math.round(raw.jobage));
  if (raw.remote && ["remote", "hybrid", "onsite"].includes(raw.remote)) out.remote = raw.remote;
  if (typeof raw.limit === "number") out.limit = Math.max(1, Math.min(25, raw.limit));
  return out;
}
