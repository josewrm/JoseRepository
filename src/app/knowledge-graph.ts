import { ALL_TERMS, textHasTerm } from "../scoring/lexicon.ts";
import { isBullet, type ParsedCv } from "../scoring/cv.ts";
import type { StructuredJd } from "../scoring/jd.ts";
import type { ScoreSheet } from "../scoring/score.ts";
import type { ProtocolRecord } from "../protocol/jarvis.ts";

/**
 * WorkSession knowledge graph, in the spirit of graphify: every node is a
 * concept, communities group them, and every edge says whether it was read
 * directly from the text (EXTRACTED) or derived by the host (INFERRED).
 */

export type Confidence = "EXTRACTED" | "INFERRED";

export interface GraphNode {
  id: string;
  label: string;
  title: string;
  community: string;
  kind: string;
  degree: number;
  page: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  confidence: Confidence;
}

export interface GraphCommunity {
  id: string;
  label: string;
  color: string;
  count: number;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunity[];
  stats: { nodes: number; edges: number; extracted_pct: number };
}

/** Tableau 10, the palette graphify uses for communities. */
const PALETTE = ["#E15759", "#F28E2B", "#EDC948", "#76B7B2", "#59A14F", "#4E79A7", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"];

export interface GraphInput {
  jd: StructuredJd | null;
  sources: { label: string; cv: ParsedCv }[];
  scoreSheet: ScoreSheet | null;
  evaluation: ProtocolRecord | null;
  events: ProtocolRecord[];
  policyDecisions: ProtocolRecord[];
  requests: ProtocolRecord[];
  reviews: ProtocolRecord[];
  evidence: ProtocolRecord[];
  form: { fields: { key: string; label: string; value: string }[] } | null;
  emailDraft: ProtocolRecord | null;
  emailSent: boolean;
  memoryProposals: ProtocolRecord[];
}

const clip = (text: string, n = 38) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const norm = (text: string) => text.replace(/^\s*[-–•*·▪]\s+/, "").replace(/\s+/g, " ").trim().toLowerCase();

export function buildKnowledgeGraph(input: GraphInput): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const communities: { id: string; label: string }[] = [];
  const community = (id: string, label: string) => {
    if (!communities.some((c) => c.id === id)) communities.push({ id, label });
    return id;
  };
  const node = (id: string, label: string, communityId: string, kind: string, page: string, title = label) => {
    if (!nodes.has(id)) nodes.set(id, { id, label: clip(label), title, community: communityId, kind, degree: 0, page });
    return id;
  };
  const edge = (from: string, to: string, relation: string, confidence: Confidence) => {
    if (from !== to && nodes.has(from) && nodes.has(to)) edges.push({ from, to, relation, confidence });
  };

  // Job posting: requirements and ATS keywords.
  const jd = input.jd;
  if (jd) {
    const c = community("oferta", "Oferta");
    node("job", jd.title ?? "Oferta", c, "job", "oferta", `${jd.title ?? "Oferta"} · ${jd.company ?? ""}`);
    if (jd.company) {
      node("company", jd.company, c, "company", "oferta");
      edge("job", "company", "posted_by", "EXTRACTED");
    }
    for (const r of [...jd.must_haves, ...jd.nice_to_haves]) {
      node(`req:${r.id}`, r.text, c, r.kind === "must" ? "must_have" : "nice_to_have", "oferta", r.text);
      edge("job", `req:${r.id}`, r.kind === "must" ? "requires" : "prefers", "EXTRACTED");
    }
    for (const term of jd.keywords) {
      node(`kw:${term}`, term, community("keywords", "Palabras clave"), "keyword", "oferta");
    }
    for (const r of [...jd.must_haves, ...jd.nice_to_haves]) for (const term of r.keywords) edge(`req:${r.id}`, `kw:${term}`, "mentions", "EXTRACTED");
  }

  // Source CVs: sections and lines; keywords link to the lines that contain them.
  const lineIndex = new Map<string, string[]>();
  input.sources.forEach((source, i) => {
    const c = community(`cv:${source.label}`, `CV ${source.label}`);
    const cvId = node(`cv:${source.label}`, `CV ${source.label}`, c, "cv", "cvs");
    for (const section of source.cv.sections) {
      const sid = node(`sec:${i}:${section.id}`, section.heading?.replace(/^#+\s*/, "") || section.id, c, "section", "cvs");
      edge(cvId, sid, "contains", "EXTRACTED");
      section.lines.forEach((line, j) => {
        const text = line.trim();
        if (!text || (!isBullet(line) && section.kind !== "skills" && section.kind !== "summary" && j > 1)) return;
        const lid = node(`line:${i}:${section.id}:${j}`, text.replace(/^\s*[-–•*·▪]\s+/, ""), c, "line", "cvs", text);
        edge(sid, lid, "contains", "EXTRACTED");
        lineIndex.set(norm(text), [...(lineIndex.get(norm(text)) ?? []), lid]);
        for (const term of jd?.keywords ?? []) if (textHasTerm(ALL_TERMS, term, text)) edge(`kw:${term}`, lid, "found_in", "EXTRACTED");
      });
    }
  });

  // Evaluation: which requirements each CV meets (scorer output = inferred).
  const ev = input.evaluation;
  if (ev) {
    const c = community("evaluacion", "Evaluación");
    node("eval", `Evaluación ${ev.target_pct}%`, c, "evaluation", "evaluacion");
    edge("eval", "job", "evaluates", "INFERRED");
    for (const s of ev.sources ?? []) {
      const id = node(`score:${s.label}`, `${s.label} ${s.before.pct}→${s.after.pct}%`, c, "score", "evaluacion");
      edge("eval", id, "scores", "INFERRED");
      edge(id, `cv:${s.label}`, "measures", "INFERRED");
    }
  }
  for (const r of input.scoreSheet?.requirements ?? []) {
    for (const quote of r.evidence_quotes) for (const lid of lineIndex.get(norm(quote)) ?? []) edge(`req:${r.requirement_id}`, lid, "evidenced_by", "INFERRED");
  }

  // Jarvis protocol: hash-chained events and the records they carry.
  if (input.events.length) {
    const c = community("jarvis", "Jarvis WorkSession");
    let previous: string | null = null;
    for (const e of input.events) {
      const id = node(`evt:${e.sequence}`, `${e.sequence} ${e.type}`, c, "event", "jarvis", `${e.type} · ${e.payload?.summary ?? ""}`);
      if (previous) edge(previous, id, "previous_hash", "EXTRACTED");
      previous = id;
    }
    const eventFor = (objectId: string) => input.events.find((e) => e.payload?.object_id === objectId);
    for (const d of input.policyDecisions) {
      const id = node(`pd:${d.id}`, `${d.result} ${d.requested_action.action}`, c, "policy_decision", "jarvis");
      const e = eventFor(d.id);
      if (e) edge(`evt:${e.sequence}`, id, "records", "EXTRACTED");
    }
    for (const r of input.requests) {
      const id = node(`rq:${r.id}`, `Request ${r.requested_action.action}`, c, "request", "jarvis", r.reason_summary);
      edge(`pd:${r.policy_decision_id}`, id, "opens", "EXTRACTED");
    }
    for (const r of input.reviews) {
      const id = node(`rv:${r.id}`, `Review ${r.decision}`, c, "review", "jarvis");
      if (String(r.target_ref).startsWith("request:")) edge(id, `rq:${String(r.target_ref).slice(8)}`, "resolves", "EXTRACTED");
    }
    for (const item of input.evidence) {
      const id = node(`ev:${item.id}`, item.evidence_type, c, "evidence", "jarvis", `${item.evidence_type} · ${item.artifact_ref}`);
      for (const ref of item.source_event_refs ?? []) {
        const e = input.events.find((x) => x.id === ref);
        if (e) edge(`evt:${e.sequence}`, id, "captures", "EXTRACTED");
      }
      if (item.evidence_type === "jd_snapshot" || item.evidence_type === "jd_structured") edge(id, "job", "about", "INFERRED");
      if (item.evidence_type === "cv_evaluation") edge(id, "eval", "about", "INFERRED");
    }
  }

  // Application: form fields, email, send.
  if (input.form) {
    const c = community("envio", "Formulario y envío");
    node("form", "Formulario", c, "form", "envio");
    edge("form", "job", "applies_to", "INFERRED");
    for (const f of input.form.fields) {
      if (f.key === "cover_letter") continue;
      const id = node(`field:${f.key}`, `${f.label}: ${f.value || "falta"}`, c, f.value ? "field" : "missing_field", "envio");
      edge("form", id, "has_field", "EXTRACTED");
    }
    if (input.emailDraft) {
      node("email", `Email ${input.emailDraft.language ?? ""}`, c, "email", "envio", input.emailDraft.subject);
      edge("form", "email", "carries", "EXTRACTED");
      node("send", input.emailSent ? "Enviado" : "Envío (1 clic)", c, "send", "envio");
      edge("email", "send", "sent_by", "INFERRED");
      for (const r of input.requests.filter((x) => x.requested_action.action === "send_application_email")) edge(`rq:${r.id}`, "send", "gates", "EXTRACTED");
    }
  }

  for (const m of input.memoryProposals) {
    const c = community("memoria", "Memoria y aprendizaje");
    const id = node(`mem:${m.id}`, `${m.memory_type} (${m.status})`, c, "memory", "jarvis");
    edge(id, "eval", "learned_from", "INFERRED");
  }

  for (const e of edges) {
    nodes.get(e.from)!.degree++;
    nodes.get(e.to)!.degree++;
  }
  const list = [...nodes.values()];
  const extracted = edges.filter((e) => e.confidence === "EXTRACTED").length;
  return {
    nodes: list,
    edges,
    communities: communities.map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length], count: list.filter((n) => n.community === c.id).length })),
    stats: { nodes: list.length, edges: edges.length, extracted_pct: edges.length ? Math.round((100 * extracted) / edges.length) : 0 },
  };
}
