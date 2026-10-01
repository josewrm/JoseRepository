const randomUUID = () => globalThis.crypto.randomUUID();
import type { RecordStore } from "../store/record-store.ts";
import {
  GENESIS_HASH,
  JarvisError,
  contentHash,
  createNonWorkSessionMutationHeaders,
  createWorkSessionMutationHeaders,
  type JarvisHeaders,
  type ProtocolRecord,
} from "../protocol/jarvis.ts";
import { buildPolicyRecord, evaluate, normalizedActionHash } from "../policy/apply2interview-policy.ts";
import { fetchJobPage, snapshotFromHumanText, validateJobUrl, type JobPageSnapshot } from "../adapters/job-link.ts";
import { hasUsableRequirements, structureJd, type StructuredJd } from "../scoring/jd.ts";
import { parseCv, sectionText, type ParsedCv } from "../scoring/cv.ts";
import { detectLanguage } from "../adapters/html.ts";
import { scoreFit, type CandidateFacts, type ScoreSheet } from "../scoring/score.ts";
import { applyPatch, buildCvPatch, type CvPatch } from "../adapt/section-adapter.ts";
import { TruthGuardError, checkTruth } from "../adapt/truth-guard.ts";
import { assertNoScore, draftEmail, nameFromCvHeader, type EmailDraft } from "../email/drafter.ts";
import {
  AGENT_ACTOR_ID,
  AGENT_WORKER_ID,
  HUMAN_ACTOR_ID,
  HUMAN_WORKER_ID,
  POLICY_ID,
  participantRecords,
} from "./participants.ts";

export const OBJECTIVE = "From this link, prepare the best honest application.";
export const AGENT_REF = "agent:apply2interview-heuristic-v1";
const DAY_MS = 24 * 3600 * 1000;

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface StartInput {
  job_url: string;
  master_cv?: string | null;
  candidate_facts?: CandidateFacts;
}

export interface ReviewInput {
  decision: "approve" | "narrow" | "deny" | "answer" | "needs_revision" | "correct" | "takeover";
  comments?: string;
  /** accept_cv_version narrow: section ids to accept. needs_revision: section ids to drop. */
  section_ids?: string[];
  /** use_human_supplied_jd answer: the JD text the human pasted. */
  jd_text?: string;
  /** send_application_email correct: the human's edited draft. */
  email?: { subject: string; body: string };
  /** accept_cv_version takeover: human-edited section text by section id. */
  edited_sections?: Record<string, string>;
}

interface HostState {
  snapshot_ref?: string;
  jd_ref?: string;
  score_ref?: string;
  patch_refs?: string[];
  email_ref?: string;
  accepted_cv_ref?: string;
  email_handoff_ref?: string;
  email_sent?: boolean;
  learning_proposed?: boolean;
  limitations?: string[];
  pd_by_action?: Record<string, string>;
}

const short = (hash: string) => hash.replace(/^hash:/, "").slice(0, 12);
const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export interface ServiceOptions {
  authorization: string;
  fetchImpl?: typeof fetch;
}

/**
 * The Apply2Interview AgentWorker loop plus the HumanWorker actions the UI calls.
 * Host-owned workflow. Every state change goes through the protocol record store.
 */
export class Apply2InterviewService {
  store: RecordStore;
  authorization: string;
  fetchImpl?: typeof fetch;

  constructor(store: RecordStore, options: ServiceOptions) {
    this.store = store;
    this.authorization = options.authorization;
    this.fetchImpl = options.fetchImpl;
  }

  // ------------------------------------------------------------ headers

  private nonWsHeaders(actorId: string): JarvisHeaders {
    return createNonWorkSessionMutationHeaders({
      authorization: this.authorization,
      actorId,
      idempotencyKey: `idem-${randomUUID()}`,
      requestTimestamp: this.store.nowIso(),
    });
  }

  private wsHeaders(actorId: string, workSessionId: string | null): JarvisHeaders {
    const ws = workSessionId ? this.store.getWorkSession(workSessionId) : null;
    return createWorkSessionMutationHeaders({
      authorization: this.authorization,
      actorId,
      idempotencyKey: `idem-${randomUUID()}`,
      requestTimestamp: this.store.nowIso(),
      expectedWorkSessionRevision: ws ? ws.revision : 0,
      previousEventHash: ws ? ws.last_event_hash : GENESIS_HASH,
    });
  }

  // ------------------------------------------------------- participants

  ensureParticipants(): void {
    if (this.store.getRecord("Policy", POLICY_ID)) return;
    const now = this.store.nowIso();
    const p = participantRecords(now, AGENT_REF);
    this.store.registerWorker(this.nonWsHeaders(HUMAN_ACTOR_ID), p.humanWorker);
    this.store.registerWorker(this.nonWsHeaders(HUMAN_ACTOR_ID), p.agentWorker);
    this.store.registerActor(this.nonWsHeaders(HUMAN_ACTOR_ID), p.humanActor, { objectType: "HumanWorker", record: p.humanProfile });
    this.store.registerActor(this.nonWsHeaders(HUMAN_ACTOR_ID), p.agentActor, { objectType: "AgentWorker", record: p.agentProfile });
    this.store.registerPolicy(
      this.nonWsHeaders(HUMAN_ACTOR_ID),
      buildPolicyRecord({ id: POLICY_ID, ownerWorkerId: HUMAN_WORKER_ID, createdByActorId: HUMAN_ACTOR_ID, createdAt: now }),
    );
  }

  // ------------------------------------------------------ small helpers

  private state(wsId: string): HostState {
    return this.store.getHostSession(wsId)?.state ?? {};
  }

  private setState(wsId: string, patch: Partial<HostState>): void {
    this.store.setHostState(wsId, patch);
  }

  private addLimitation(wsId: string, ref: string): void {
    const limitations = new Set(this.state(wsId).limitations ?? []);
    limitations.add(ref);
    this.setState(wsId, { limitations: [...limitations] });
  }

  private session(wsId: string) {
    const host = this.store.getHostSession(wsId);
    const ws = this.store.getWorkSession(wsId);
    if (!host || !ws) throw new UserError(`Unknown WorkSession ${wsId}`, 404);
    return { host, ws };
  }

  private jobRef(wsId: string): string {
    return `job-url:${short(contentHash(this.session(wsId).host.jobUrl))}`;
  }

  private masterCvRef(masterCv: string): string {
    return `artifact:cv-master:${short(contentHash(masterCv))}`;
  }

  /** Records a PolicyDecision for an AgentWorker action. Deny/review_required carry the Request id. */
  private decide(wsId: string, action: string, targetRef: string, extra: { requestId?: string; approvalReviewId?: string } = {}): ProtocolRecord {
    const ws = this.store.getWorkSession(wsId)!;
    const policy = this.store.getRecord("Policy", ws.policy_id)!;
    const evaluation = evaluate(policy, action);
    const requestedAction = { action, target_ref: targetRef, scope_ref: evaluation.rule.scope_ref };
    const result = extra.approvalReviewId ? "allow" : evaluation.result;
    const decision: ProtocolRecord = {
      id: newId("pd"),
      work_session_id: wsId,
      actor_id: AGENT_ACTOR_ID,
      policy_id: ws.policy_id,
      requested_action: requestedAction,
      normalized_action_hash: normalizedActionHash(requestedAction),
      risk_class: evaluation.rule.risk_class,
      result,
      reason: extra.approvalReviewId
        ? `Review ${extra.approvalReviewId} approved ${action}; execution is bounded by its ApprovalScope.`
        : evaluation.reason,
      created_at: this.store.nowIso(),
      data_sensitivity: action === "fetch_public_jd" ? "public" : "private",
    };
    if (result === "allow") decision.selected_grant_refs = extra.approvalReviewId ? [`approval-scope:${extra.approvalReviewId}`] : [`grant:${action}`];
    else decision.denied_grant_refs = [`grant:${action}`];
    if (result !== "allow") decision.request_id = extra.requestId;
    this.store.recordPolicyDecision(this.wsHeaders(AGENT_ACTOR_ID, wsId), wsId, decision, { lockEpoch: this.store.lockEpoch(wsId) });
    const pdByAction = { ...(this.state(wsId).pd_by_action ?? {}), [action]: decision.id };
    this.setState(wsId, { pd_by_action: pdByAction });
    return decision;
  }

  private binding(decision: ProtocolRecord, purpose?: "blocked_scope") {
    return { policyDecisionId: decision.id, action: decision.requested_action.action, lockEpoch: this.store.lockEpoch(decision.work_session_id), ...(purpose ? { purpose } : {}) };
  }

  /** Stores an artifact (host) and captures its EvidenceItemRef (protocol) in one event. */
  private capture(
    wsId: string,
    by: { actorId: string; decision?: ProtocolRecord },
    item: { kind: string; evidenceType: string; content: unknown; trustLabel: string; limitations?: string[]; summary: string; refSuffix?: string },
  ): { artifactRef: string; evidenceId: string; eventId: string; contentHash: string } {
    const hash = contentHash(item.content);
    const artifactRef = `artifact:${item.kind}:${item.refSuffix ? `${item.refSuffix}:` : ""}${short(hash)}`;
    this.store.putArtifact(wsId, artifactRef, item.kind, item.content);
    const evidenceId = newId("evidence");
    const result = this.store.appendJarvisEvent(
      this.wsHeaders(by.actorId, wsId),
      wsId,
      {
        actor_id: by.actorId,
        type: "evidence.captured",
        payload: {
          object_type: "evidence_item",
          object_id: evidenceId,
          action: "captured",
          field_refs: [artifactRef],
          evidence_refs: [evidenceId],
          summary: item.summary,
        },
        writes: (ctx) => [
          {
            objectType: "EvidenceItemRef",
            record: {
              id: evidenceId,
              work_session_id: wsId,
              source_event_refs: [ctx.eventId],
              captured_by_actor_id: by.actorId,
              evidence_type: item.evidenceType,
              artifact_ref: artifactRef,
              content_hash: hash,
              trust_label: item.trustLabel,
              redaction_state: "none",
              captured_at: ctx.now,
              limitation_refs: item.limitations?.length ? item.limitations : ["limitation:none-recorded"],
            },
          },
        ],
      },
      by.decision ? this.binding(by.decision) : undefined,
    );
    return { artifactRef, evidenceId, eventId: result.event!.id, contentHash: hash };
  }

  private contribute(
    wsId: string,
    who: "human" | "agent" | "shared",
    type: string,
    refs: { events: string[]; artifacts?: string[]; reviews?: string[]; evidence?: string[]; limitations?: string[]; confidence?: number },
    decision?: ProtocolRecord,
  ): ProtocolRecord {
    const human = { worker_id: HUMAN_WORKER_ID, actor_id: HUMAN_ACTOR_ID, contribution_role: "human" };
    const agent = { worker_id: AGENT_WORKER_ID, actor_id: AGENT_ACTOR_ID, contribution_role: "agent" };
    const contribution: ProtocolRecord = {
      id: newId("contribution"),
      work_session_id: wsId,
      contributor_refs: who === "human" ? [human] : who === "agent" ? [agent] : [human, agent],
      contributor_type: who,
      contribution_type: type,
      event_refs: refs.events,
      created_at: this.store.nowIso(),
      ...(refs.artifacts?.length ? { artifact_refs: refs.artifacts } : {}),
      ...(refs.reviews?.length ? { review_refs: refs.reviews } : {}),
      ...(refs.evidence?.length ? { evidence_refs: refs.evidence } : {}),
      ...(refs.limitations?.length ? { limitations: refs.limitations } : {}),
      ...(refs.confidence !== undefined ? { confidence: refs.confidence } : {}),
    };
    const actorId = who === "agent" ? AGENT_ACTOR_ID : HUMAN_ACTOR_ID;
    this.store.recordContribution(this.wsHeaders(actorId, wsId), wsId, contribution, who === "agent" && decision ? this.binding(decision) : undefined);
    return contribution;
  }

  /** PolicyDecision (review_required/deny) + Request + waiting_on_human. */
  private openRequest(
    wsId: string,
    action: string,
    targetRef: string,
    spec: {
      type: string;
      reason_code: string;
      reason_summary: string;
      requested_outcome: string;
      human_decision_needed: string;
      options: ProtocolRecord[];
      recommended_option?: string;
      default_if_no_response: ProtocolRecord;
      missing?: string;
      evidence_refs?: string[];
      artifact_refs?: string[];
    },
  ): ProtocolRecord {
    const requestId = newId("req");
    const decision = this.decide(wsId, action, targetRef, { requestId });
    const now = this.store.nowIso();
    const ws = this.store.getWorkSession(wsId)!;
    const policy = this.store.getRecord("Policy", ws.policy_id)!;
    const request: ProtocolRecord = {
      id: requestId,
      protocol_version: "v0.1",
      work_session_id: wsId,
      requester_actor_id: AGENT_ACTOR_ID,
      requester_worker_id: AGENT_WORKER_ID,
      target_human_worker_id: HUMAN_WORKER_ID,
      policy_decision_id: decision.id,
      type: spec.type,
      blocking_scope: evaluate(policy, action).rule.blocking_scope,
      reason_code: spec.reason_code,
      reason_summary: spec.reason_summary,
      requested_action: decision.requested_action,
      requested_outcome: spec.requested_outcome,
      risk_class: decision.risk_class,
      human_decision_needed: spec.human_decision_needed,
      options: spec.options,
      default_if_no_response: spec.default_if_no_response,
      status: "pending",
      created_at: now,
      expires_at: new Date(Date.parse(now) + 7 * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
      policy_refs: [ws.policy_id],
      data_sensitivity: decision.data_sensitivity,
      ...(spec.missing ? { missing_permission_or_context: spec.missing } : {}),
      ...(spec.recommended_option ? { recommended_option: spec.recommended_option } : {}),
      ...(spec.evidence_refs?.length ? { evidence_refs: spec.evidence_refs } : {}),
      ...(spec.artifact_refs?.length ? { artifact_refs: spec.artifact_refs } : {}),
    };
    this.store.createRequest(this.wsHeaders(AGENT_ACTOR_ID, wsId), wsId, request, this.binding(decision));
    if (this.store.getWorkSession(wsId)!.status === "active") {
      this.store.appendJarvisEvent(
        this.wsHeaders(AGENT_ACTOR_ID, wsId),
        wsId,
        {
          actor_id: AGENT_ACTOR_ID,
          type: "work_session.waiting_on_human",
          status_to: "waiting_on_human",
          payload: {
            object_type: "work_session",
            object_id: wsId,
            action: "waiting_on_human",
            field_refs: [`request:${requestId}`, `blocking_scope:${request.blocking_scope}`],
            summary: `Blocked scope ${request.blocking_scope} waits on HumanWorker: ${spec.reason_code}.`,
          },
        },
        this.binding(decision, "blocked_scope"),
      );
    }
    return request;
  }

  // ------------------------------------------------------------- start

  async startSession(input: StartInput): Promise<string> {
    const checked = validateJobUrl(input.job_url ?? "");
    if (!checked.ok) throw new UserError(checked.detail);
    this.ensureParticipants();
    const wsId = `ws-${randomUUID().slice(0, 12)}`;
    const facts = normalizeFacts((input.candidate_facts ?? {}) as Record<string, unknown>);
    const masterCv = input.master_cv?.trim() ? input.master_cv.replace(/\r\n/g, "\n") : null;
    const created = this.store.createWorkSession(this.wsHeaders(HUMAN_ACTOR_ID, null), {
      id: wsId,
      created_by_actor_id: HUMAN_ACTOR_ID,
      objective: OBJECTIVE,
      human_worker_id: HUMAN_WORKER_ID,
      agent_worker_id: AGENT_WORKER_ID,
      policy_id: POLICY_ID,
      source_ref: `job-url:${short(contentHash(checked.url.href))}`,
    });
    this.store.saveHostSession(wsId, { jobUrl: checked.url.href, masterCv, facts });
    this.contribute(wsId, "human", "intent", {
      events: [created.event!.id],
      artifacts: masterCv ? [this.masterCvRef(masterCv)] : [],
      limitations: masterCv ? [] : ["limitation:no-master-cv"],
    });
    if (masterCv) this.store.putArtifact(wsId, this.masterCvRef(masterCv), "cv-master", { text: masterCv });
    else this.addLimitation(wsId, "limitation:no-master-cv");
    await this.runAgent(wsId);
    return wsId;
  }

  // -------------------------------------------------------- agent loop

  /** Advances every branch that is not blocked. Idempotent: finished steps are skipped. */
  async runAgent(wsId: string): Promise<void> {
    const { ws } = this.session(wsId);
    if (["completed", "failed", "cancelled", "closed"].includes(ws.status)) return;
    const pending = this.pendingRequests(wsId);
    const blocked = (action: string) => pending.some((r) => r.requested_action.action === action);
    if (blocked("use_human_supplied_jd")) return;

    if (!this.state(wsId).jd_ref) {
      const ok = await this.acquireJd(wsId);
      if (!ok) return;
    }
    this.scoreIfPossible(wsId);
    if (!blocked("accept_cv_version")) this.proposeCvIfPossible(wsId);
    if (!blocked("send_application_email")) this.draftEmailIfNeeded(wsId);
  }

  private async acquireJd(wsId: string): Promise<boolean> {
    const { host } = this.session(wsId);
    let state = this.state(wsId);
    if (!state.snapshot_ref) {
      const fetchDecision = this.decide(wsId, "fetch_public_jd", this.jobRef(wsId));
      const outcome = await fetchJobPage(host.jobUrl, { fetchImpl: this.fetchImpl, now: () => this.store.clock() });
      if (!outcome.ok) {
        const failure = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision: fetchDecision }, {
          kind: "jd-fetch-failure",
          evidenceType: "jd_fetch_failure",
          content: { url: host.jobUrl, reason: outcome.reason, detail: outcome.detail, http_status: outcome.http_status ?? null, final_url: outcome.final_url ?? null, at: this.store.nowIso() },
          trustLabel: "observed",
          limitations: ["limitation:jd-unavailable"],
          summary: `Job page unusable (${outcome.reason}). No JD was invented.`,
        });
        this.addLimitation(wsId, "limitation:jd-unavailable");
        this.openJdRequest(wsId, `jd_${outcome.reason}`, `Could not read a public job description: ${outcome.detail}`, [failure.evidenceId], [failure.artifactRef]);
        return false;
      }
      const snap = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision: fetchDecision }, {
        kind: "jd-snapshot",
        evidenceType: "jd_snapshot",
        content: outcome.snapshot,
        trustLabel: "external_unreviewed",
        summary: `Captured public JD snapshot (${outcome.snapshot.extraction}).`,
      });
      this.setState(wsId, { snapshot_ref: snap.artifactRef });
      state = this.state(wsId);
    }
    return this.structure(wsId, state.snapshot_ref!);
  }

  private structure(wsId: string, snapshotRef: string): boolean {
    const snapshot = this.store.getArtifact(snapshotRef)!;
    const decision = this.decide(wsId, "structure_jd", snapshotRef);
    const jd = structureJd(snapshot.content as JobPageSnapshot, snapshot.contentHash);
    if (!hasUsableRequirements(jd)) {
      this.addLimitation(wsId, "limitation:jd-without-requirements");
      this.openJdRequest(wsId, "jd_no_requirements", "The page has text but no identifiable job requirements. Scoring would be guesswork, so it is stopped.", [], [snapshotRef]);
      return false;
    }
    const limitations = jd.translation.status === "not_translated" ? ["limitation:jd-not-translated"] : [];
    for (const limitation of limitations) this.addLimitation(wsId, limitation);
    const captured = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision }, {
      kind: "jd-structured",
      evidenceType: "jd_structured",
      content: jd,
      trustLabel: "derived_verbatim",
      limitations,
      summary: `Structured JD: ${jd.must_haves.length} must-haves, ${jd.nice_to_haves.length} nice-to-haves (${jd.language}).`,
    });
    this.contribute(wsId, "agent", "research", { events: [captured.eventId], artifacts: [snapshotRef, captured.artifactRef], evidence: [captured.evidenceId] }, decision);
    this.setState(wsId, { jd_ref: captured.artifactRef });
    return true;
  }

  private openJdRequest(wsId: string, reasonCode: string, summary: string, evidenceRefs: string[], artifactRefs: string[]): void {
    this.openRequest(wsId, "use_human_supplied_jd", this.jobRef(wsId), {
      type: "context",
      reason_code: reasonCode,
      reason_summary: summary,
      requested_outcome: "HumanWorker pastes the job description text, or cancels this WorkSession.",
      human_decision_needed: "Answer with the JD text you can see, or deny to stop. The agent will not guess the JD.",
      missing: "Public job description text",
      options: [
        { id: "option-paste-jd", label: "Paste the job description", effect: "The agent structures the pasted text and continues scoring, CV patch, and email draft.", risk_class: "medium", scope_ref: "scope:jd-source" },
        { id: "option-stop", label: "Stop", effect: "The WorkSession is cancelled with an evidence limitation. Nothing is invented.", risk_class: "low", scope_ref: "scope:jd-source" },
      ],
      recommended_option: "option-paste-jd",
      default_if_no_response: { action: "keep_branch_stopped", reason: "No JD is invented; scoring, CV adaptation and email stay stopped.", limitation_ref: "limitation:jd-unavailable" },
      evidence_refs: evidenceRefs,
      artifact_refs: artifactRefs,
    });
  }

  private loadInputs(wsId: string): { jd: StructuredJd; jdHash: string; cv: ParsedCv | null; cvHash: string | null; facts: CandidateFacts; masterCv: string | null } {
    const { host } = this.session(wsId);
    const state = this.state(wsId);
    const jdArtifact = this.store.getArtifact(state.jd_ref!)!;
    const jd = jdArtifact.content as StructuredJd;
    const masterCv: string | null = host.masterCv;
    const cv = masterCv ? parseCv(masterCv, detectLanguage(masterCv)) : null;
    return { jd, jdHash: jd.source.snapshot_hash, cv, cvHash: masterCv ? contentHash(masterCv) : null, facts: host.facts, masterCv };
  }

  private scoreIfPossible(wsId: string): void {
    const state = this.state(wsId);
    if (state.score_ref || !state.jd_ref) return;
    const { jd, jdHash, cv, cvHash, facts } = this.loadInputs(wsId);
    if (!cv) return;
    const decision = this.decide(wsId, "score_fit", state.jd_ref);
    const sheet = scoreFit(jd, cv, facts, { jdSnapshot: jdHash, masterCv: cvHash! }, this.store.clock());
    const captured = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision }, {
      kind: "score-sheet",
      evidenceType: "score_sheet",
      content: sheet,
      trustLabel: "computed_heuristic_v1",
      limitations: sheet.unverified.length ? ["limitation:unverified-requirements"] : [],
      summary: `Fit ${sheet.fit_score.value}/100; apply_to_interview_pct ${sheet.apply_to_interview_pct.value} (${sheet.apply_to_interview_pct.band}, heuristic_v1).`,
    });
    if (sheet.unverified.length) this.addLimitation(wsId, "limitation:unverified-requirements");
    this.contribute(wsId, "agent", "artifact", { events: [captured.eventId], artifacts: [captured.artifactRef], evidence: [captured.evidenceId] }, decision);
    this.setState(wsId, { score_ref: captured.artifactRef });
  }

  private proposeCvIfPossible(wsId: string, dropSectionIds: string[] = [], derivedFrom: CvPatch | null = null): void {
    const state = this.state(wsId);
    if (!state.score_ref || state.accepted_cv_ref) return;
    if (!derivedFrom && state.patch_refs?.length) return;
    const { jd, jdHash, cv, cvHash, facts } = this.loadInputs(wsId);
    if (!cv) return;
    const score = this.store.getArtifact(state.score_ref)!.content as ScoreSheet;
    const decision = this.decide(wsId, "propose_cv_section_edits", this.masterCvRef(cv.text));
    let patch: CvPatch;
    try {
      patch = buildCvPatch(cv, jd, score, {
        version: (state.patch_refs?.length ?? 0) + 1,
        derivedFromVersion: derivedFrom?.version ?? null,
        dropSectionIds: [...(derivedFrom?.dropped_section_ids ?? []), ...dropSectionIds],
        factsText: factsText(facts),
        hashes: { masterCv: cvHash!, jdSnapshot: jdHash },
      });
    } catch (error) {
      if (!(error instanceof TruthGuardError)) throw error;
      const failure = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision }, {
        kind: "cv-truth-guard-failure",
        evidenceType: "truth_guard_failure",
        content: { violations: error.violations },
        trustLabel: "observed",
        limitations: ["limitation:cv-patch-rejected-by-truth-guard"],
        summary: "Truth guard rejected the CV patch; no adapted CV was produced.",
      });
      this.addLimitation(wsId, "limitation:cv-patch-rejected-by-truth-guard");
      void failure;
      return;
    }
    const captured = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision }, {
      kind: "cv-patch",
      refSuffix: `v${patch.version}`,
      evidenceType: "cv_section_diff",
      content: patch,
      trustLabel: "agent_proposed",
      summary: `cvs_best_version v${patch.version}: ${patch.sections.length} adapted sections, ${patch.unchanged_section_ids.length} unchanged, truth guard passed.`,
    });
    this.contribute(wsId, "agent", "artifact", { events: [captured.eventId], artifacts: [captured.artifactRef], evidence: [captured.evidenceId] }, decision);
    this.setState(wsId, { patch_refs: [...(state.patch_refs ?? []), captured.artifactRef] });
    if (!patch.sections.length) {
      this.addLimitation(wsId, "limitation:no-cv-section-changes");
      return;
    }
    this.openRequest(wsId, "accept_cv_version", captured.artifactRef, {
      type: "review",
      reason_code: "cv_version_choice",
      reason_summary: `cvs_best_version v${patch.version} reorders ${patch.sections.map((s) => s.section_id).join(", ")} using only master CV lines. Choose the accepted version.`,
      requested_outcome: "HumanWorker approves the version, keeps only some sections (narrow), asks for a revision, edits by hand (takeover), or keeps the master CV (deny).",
      human_decision_needed: "Which adapted sections become part of the accepted CV?",
      options: [
        { id: "option-approve-all", label: "Accept all adapted sections", effect: "Accepted CV = master CV with every adapted section applied.", risk_class: "medium", scope_ref: "scope:cv-acceptance" },
        { id: "option-narrow", label: "Accept selected sections", effect: "Only the selected sections change; the rest stay as in the master CV.", risk_class: "low", scope_ref: "scope:cv-acceptance" },
        { id: "option-revise", label: "Drop sections and revise", effect: "The agent proposes a new version without the dropped sections; this version stays as a Contribution.", risk_class: "low", scope_ref: "scope:cv-proposal" },
        { id: "option-takeover", label: "Edit sections myself", effect: "Human Takeover of the CV acceptance scope; edits pass the truth guard.", risk_class: "medium", scope_ref: "scope:cv-acceptance" },
        { id: "option-keep-master", label: "Keep the master CV", effect: "No adapted section is used.", risk_class: "low", scope_ref: "scope:master-cv" },
      ],
      recommended_option: "option-approve-all",
      default_if_no_response: { action: "keep_master_cv", reason: "The master CV stays unchanged and the patch stays a proposal.", limitation_ref: "limitation:cv-version-not-reviewed" },
      evidence_refs: [captured.evidenceId],
      artifact_refs: [captured.artifactRef],
    });
  }

  private draftEmailIfNeeded(wsId: string, humanEdit?: { subject: string; body: string }): void {
    const state = this.state(wsId);
    if (!state.jd_ref || state.email_handoff_ref) return;
    if (state.email_ref && !humanEdit) return;
    const { jd, cv, facts } = this.loadInputs(wsId);
    const score = state.score_ref ? (this.store.getArtifact(state.score_ref)!.content as ScoreSheet) : null;
    let emailRef: string;
    let evidenceId: string;
    if (humanEdit) {
      const draft = { ...draftEmail(jd, score, facts, null), subject: humanEdit.subject, body: humanEdit.body, edited_by: "human" };
      assertNoScore(draft, score);
      const captured = this.capture(wsId, { actorId: HUMAN_ACTOR_ID }, {
        kind: "email-draft",
        evidenceType: "email_draft",
        content: draft,
        trustLabel: "human_authored",
        summary: "HumanWorker corrected the email draft.",
      });
      this.contribute(wsId, "human", "correction", { events: [captured.eventId], artifacts: [captured.artifactRef], evidence: [captured.evidenceId] });
      emailRef = captured.artifactRef;
      evidenceId = captured.evidenceId;
    } else {
      const decision = this.decide(wsId, "draft_application_email", state.jd_ref);
      const header = cv?.sections.find((s) => s.kind === "header");
      const draft: EmailDraft = draftEmail(jd, score, facts, header ? nameFromCvHeader(header.lines) : null);
      const captured = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision }, {
        kind: "email-draft",
        evidenceType: "email_draft",
        content: draft,
        trustLabel: "agent_proposed",
        summary: `Email draft (${draft.language}) captured; not sent.`,
      });
      this.contribute(wsId, "agent", "artifact", { events: [captured.eventId], artifacts: [captured.artifactRef], evidence: [captured.evidenceId] }, decision);
      emailRef = captured.artifactRef;
      evidenceId = captured.evidenceId;
    }
    this.setState(wsId, { email_ref: emailRef });
    this.openRequest(wsId, "send_application_email", emailRef, {
      type: "permission",
      reason_code: "external_send_requires_review",
      reason_summary: "The application email is drafted. Policy keeps sending at needs_human until you approve it.",
      requested_outcome: "HumanWorker approves the exact draft for sending, corrects it, or denies sending.",
      human_decision_needed: "Approve this exact draft for you to send, correct it, or keep it unsent.",
      missing: "HumanWorker approval for an external send",
      options: [
        { id: "option-approve-send", label: "Approve this draft", effect: "The host hands the approved draft to you (mailto/copy). It never sends on its own.", risk_class: "high", scope_ref: "scope:external-email" },
        { id: "option-correct", label: "Correct the draft", effect: "Your edited draft replaces this one and comes back for approval.", risk_class: "low", scope_ref: "scope:email-draft" },
        { id: "option-deny-send", label: "Do not send", effect: "The draft stays unsent.", risk_class: "low", scope_ref: "scope:email-draft" },
      ],
      recommended_option: "option-correct",
      default_if_no_response: { action: "keep_unsent", reason: "Sending stays blocked; the draft remains a draft.", limitation_ref: "limitation:email-not-approved" },
      evidence_refs: [evidenceId],
      artifact_refs: [emailRef],
    });
  }

  // --------------------------------------------------------- reviews

  pendingRequests(wsId: string): ProtocolRecord[] {
    return this.store.listRecords(wsId, "Request").filter((r) => ["pending", "acknowledged"].includes(r.status));
  }

  async review(wsId: string, requestId: string, input: ReviewInput): Promise<void> {
    const { host } = this.session(wsId);
    const request = this.store.getRecord("Request", requestId);
    if (!request || request.work_session_id !== wsId) throw new UserError("Unknown Request", 404);
    if (!["pending", "acknowledged"].includes(request.status)) throw new UserError(`Request is already ${request.status}.`, 409);
    const action: string = request.requested_action.action;
    const allowed: Record<string, ReviewInput["decision"][]> = {
      use_human_supplied_jd: ["answer", "deny"],
      accept_cv_version: ["approve", "narrow", "needs_revision", "takeover", "deny"],
      send_application_email: ["approve", "correct", "deny"],
      confirm_memory: ["approve", "deny"],
    };
    if (!allowed[action]?.includes(input.decision)) throw new UserError(`Decision ${input.decision} does not apply to ${action}.`);

    const reviewId = newId("review");
    const review: ProtocolRecord = {
      id: reviewId,
      work_session_id: wsId,
      reviewer_actor_id: HUMAN_ACTOR_ID,
      reviewer_worker_id: HUMAN_WORKER_ID,
      target_ref: `request:${requestId}`,
      decision: input.decision,
      created_at: this.store.nowIso(),
    };
    if (input.comments?.trim()) review.comments = input.comments.trim().slice(0, 2000);

    let humanJdRef: string | null = null;
    if (action === "use_human_supplied_jd" && input.decision === "answer") {
      const text = (input.jd_text ?? "").trim();
      if (text.length < 200) throw new UserError("Paste the full job description (at least 200 characters).");
      const snapshot = snapshotFromHumanText(text, host.jobUrl, this.store.nowIso());
      humanJdRef = `artifact:jd-snapshot:human:${short(contentHash(snapshot))}`;
      review.comments = `${review.comments ? `${review.comments} ` : ""}HumanWorker supplied the JD text as ${humanJdRef}.`;
      this.store.putArtifact(wsId, humanJdRef, "jd-snapshot", snapshot);
    }

    let takeover: ProtocolRecord | null = null;
    if (action === "accept_cv_version" && input.decision === "takeover") {
      if (!input.edited_sections || !Object.keys(input.edited_sections).length) throw new UserError("Takeover needs the edited section text.");
      // Validate before any protocol mutation: human rewording is allowed, new facts are not.
      const { masterCv, facts } = this.loadInputs(wsId);
      checkTruth(Object.entries(input.edited_sections).map(([id, text]) => ({ section_id: id, after: text })), masterCv!, factsText(facts), { lineCheck: false });
      takeover = this.startTakeover(wsId, request);
      review.takeover_id = takeover.id;
    }

    if (["approve", "narrow"].includes(input.decision)) {
      const requestEvent = this.store.findEventFor(wsId, "request.created", requestId)!;
      const decision = this.store.getRecord("PolicyDecision", request.policy_decision_id)!;
      const sections = input.decision === "narrow" ? (input.section_ids ?? []) : [];
      if (input.decision === "narrow" && !sections.length) throw new UserError("Narrow needs at least one section to accept.");
      review.approval_scope = {
        request_id: requestId,
        review_id: reviewId,
        policy_decision_id: request.policy_decision_id,
        request_revision: requestEvent.sequence,
        request_event_hash: requestEvent.event_hash,
        normalized_action_hash: decision.normalized_action_hash,
        approved_action: request.requested_action,
        allowed_scope: {
          scope_ref: request.requested_action.scope_ref,
          grant_refs: [`grant:${action}:approved-once`],
          ...(sections.length ? { constraint_refs: sections.map((id) => `section:${id}`) } : {}),
        },
        denied_scope: { scope_ref: sections.length ? "scope:cv-sections-not-accepted" : "scope:any-other-action" },
        expires_at: new Date(this.store.clock().getTime() + DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
        max_uses: 1,
        applies_to_work_session_id: wsId,
        applies_to_actor_id: AGENT_ACTOR_ID,
      };
    }
    if (input.decision === "needs_revision") review.required_changes = (input.section_ids ?? []).map((id) => `drop_section:${id}`);
    if (input.decision === "correct") review.required_changes = ["replace_email_draft_with_human_edit"];

    const recorded = this.store.recordReview(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, review);
    this.contribute(wsId, "human", input.decision === "correct" ? "correction" : "review", { events: [recorded.event!.id], reviews: [reviewId] });

    // Continue inside the decided scope.
    switch (action) {
      case "use_human_supplied_jd":
        if (input.decision === "answer") {
          this.reactivateIfClear(wsId);
          this.setState(wsId, { snapshot_ref: humanJdRef! });
          const evidence = this.capture(wsId, { actorId: HUMAN_ACTOR_ID }, {
            kind: "jd-snapshot",
            refSuffix: "human",
            evidenceType: "jd_snapshot",
            content: this.store.getArtifact(humanJdRef!)!.content,
            trustLabel: "human_supplied",
            summary: "HumanWorker supplied the job description text.",
          });
          this.setState(wsId, { snapshot_ref: evidence.artifactRef });
          if (this.structure(wsId, evidence.artifactRef)) await this.runAgent(wsId);
        } else {
          this.endWorkSession(wsId, "cancelled", [`review:${reviewId}`], "HumanWorker stopped the WorkSession: no JD available.");
        }
        return;
      case "accept_cv_version":
        await this.afterCvReview(wsId, request, review, input, takeover);
        break;
      case "send_application_email":
        if (input.decision === "approve") {
          const decision = this.decide(wsId, "send_application_email", request.requested_action.target_ref, { approvalReviewId: reviewId });
          const email = this.store.getArtifact(request.requested_action.target_ref)!.content as EmailDraft;
          const handoff = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision }, {
            kind: "email-handoff",
            evidenceType: "email_send_handoff",
            content: { approved_draft_ref: request.requested_action.target_ref, review_id: reviewId, to: email.to, subject: email.subject, body: email.body, delivery: "human_sends_manually", sent_by_host: false },
            trustLabel: "human_reviewed",
            summary: "Approved draft handed to the HumanWorker for sending. The host does not send email.",
          });
          this.setState(wsId, { email_handoff_ref: handoff.artifactRef });
        } else if (input.decision === "correct") {
          if (!input.email?.body?.trim() || !input.email?.subject?.trim()) throw new UserError("Correct needs the edited subject and body.");
          this.draftEmailIfNeeded(wsId, { subject: input.email.subject.trim(), body: input.email.body.trim() });
        } else {
          this.addLimitation(wsId, "limitation:email-not-approved");
        }
        break;
      case "confirm_memory":
        this.afterMemoryReview(wsId, request, review);
        break;
    }
    this.reactivateIfClear(wsId);
    await this.runAgent(wsId);
  }

  private async afterCvReview(wsId: string, request: ProtocolRecord, review: ProtocolRecord, input: ReviewInput, takeover: ProtocolRecord | null): Promise<void> {
    const patchRef: string = request.requested_action.target_ref;
    const patch = this.store.getArtifact(patchRef)!.content as CvPatch;
    const { cv, facts, masterCv } = this.loadInputs(wsId);
    if (input.decision === "approve" || input.decision === "narrow") {
      const accepted = input.decision === "narrow" ? patch.sections.map((s) => s.section_id).filter((id) => input.section_ids!.includes(id)) : patch.sections.map((s) => s.section_id);
      const decision = this.decide(wsId, "accept_cv_version", patchRef, { approvalReviewId: review.id });
      const content = {
        schema: "apply2interview.accepted_cv.v1",
        patch_ref: patchRef,
        patch_version: patch.version,
        review_id: review.id,
        accepted_section_ids: accepted,
        rejected_section_ids: patch.sections.map((s) => s.section_id).filter((id) => !accepted.includes(id)),
        master_cv_unchanged: true,
        text: applyPatch(cv!, patch, accepted),
      };
      const captured = this.capture(wsId, { actorId: AGENT_ACTOR_ID, decision }, {
        kind: "cv-accepted",
        evidenceType: "cv_accepted_version",
        content,
        trustLabel: "human_reviewed",
        summary: `Accepted CV version v${patch.version} with sections ${accepted.join(", ") || "none"}.`,
      });
      this.contribute(wsId, "shared", "artifact", { events: [captured.eventId], artifacts: [patchRef, captured.artifactRef], reviews: [review.id], evidence: [captured.evidenceId] });
      this.setState(wsId, { accepted_cv_ref: captured.artifactRef });
    } else if (input.decision === "needs_revision") {
      this.reactivateIfClear(wsId);
      this.proposeCvIfPossible(wsId, input.section_ids ?? [], patch);
    } else if (input.decision === "takeover" && takeover) {
      this.finishTakeover(wsId, takeover, patch, cv!, masterCv!, facts, input.edited_sections!, review);
    } else {
      this.addLimitation(wsId, "limitation:cv-adaptation-declined");
    }
  }

  // ------------------------------------------------------------ takeover

  private startTakeover(wsId: string, request: ProtocolRecord): ProtocolRecord {
    const takeover: ProtocolRecord = {
      id: newId("takeover"),
      work_session_id: wsId,
      requested_by_actor_id: HUMAN_ACTOR_ID,
      controlling_actor_id: HUMAN_ACTOR_ID,
      request_id: request.id,
      affected_scope: {
        blocking_scope: request.blocking_scope,
        scope_ref: request.requested_action.scope_ref,
        normalized_action_hash: this.store.getRecord("PolicyDecision", request.policy_decision_id)!.normalized_action_hash,
        artifact_refs: [request.requested_action.target_ref],
      },
      reason: "HumanWorker edits CV sections directly.",
      lock_epoch: this.store.lockEpoch(wsId) + 1,
      state: "human_active",
      created_at: this.store.nowIso(),
    };
    const result = this.store.recordTakeover(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, takeover);
    return result.records[0];
  }

  private finishTakeover(wsId: string, takeover: ProtocolRecord, patch: CvPatch, cv: ParsedCv, masterCv: string, facts: CandidateFacts, edited: Record<string, string>, review: ProtocolRecord): void {
    const known = new Map(cv.sections.map((s) => [s.id, s]));
    const edits = Object.entries(edited).filter(([id]) => known.has(id));
    void masterCv;
    void facts;
    const text = cv.sections.map((s) => edited[s.id]?.trim() || sectionText(s)).join("\n\n");
    const captured = this.capture(wsId, { actorId: HUMAN_ACTOR_ID }, {
      kind: "cv-accepted",
      evidenceType: "cv_accepted_version",
      content: { schema: "apply2interview.accepted_cv.v1", patch_ref: `artifact:cv-patch:v${patch.version}`, review_id: review.id, takeover_id: takeover.id, human_edited_section_ids: edits.map(([id]) => id), master_cv_unchanged: true, text },
      trustLabel: "human_authored",
      summary: `HumanWorker edited ${edits.map(([id]) => id).join(", ")} under Takeover; truth guard passed.`,
    });
    const contribution = this.contribute(wsId, "human", "correction", { events: [captured.eventId], artifacts: [captured.artifactRef], reviews: [review.id], evidence: [captured.evidenceId] });
    const reconciliation = { ...takeover, state: "reconciliation_required" };
    this.store.recordTakeover(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, reconciliation);
    this.store.recordTakeover(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, {
      ...reconciliation,
      state: "resumed",
      resumed_by_actor_id: HUMAN_ACTOR_ID,
      reconciliation_notes: "Human-edited CV accepted; agent continues on other branches.",
      reconciliation_refs: [`contribution:${contribution.id}`, captured.artifactRef, `evidence:${captured.evidenceId}`],
      resolved_at: this.store.nowIso(),
    });
    this.setState(wsId, { accepted_cv_ref: captured.artifactRef });
  }

  // ------------------------------------------------------ human actions

  /** waiting_on_human -> active once every blocked scope is resolved. */
  private reactivateIfClear(wsId: string): void {
    const ws = this.store.getWorkSession(wsId)!;
    if (ws.status !== "waiting_on_human" || this.pendingRequests(wsId).length) return;
    const resolvedRefs = this.store
      .listRecords(wsId, "Request")
      .map((r) => (r.resolved_by_review_id ? `review:${r.resolved_by_review_id}` : r.resolved_by_takeover_id ? `takeover:${r.resolved_by_takeover_id}` : r.closed_by_event_ref ? `request_closure:${r.closed_by_event_ref}` : null))
      .filter((ref): ref is string => Boolean(ref));
    this.store.appendJarvisEvent(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, {
      actor_id: HUMAN_ACTOR_ID,
      type: "work_session.activated",
      status_to: "active",
      payload: { object_type: "work_session", object_id: wsId, action: "activated", field_refs: resolvedRefs, summary: "Every blocked scope is resolved; work continues." },
    });
  }

  markEmailSent(wsId: string, note?: string): void {
    const state = this.state(wsId);
    if (!state.email_handoff_ref) throw new UserError("Only an approved email draft can be marked as sent.", 409);
    if (state.email_sent) return;
    const handoffEvent = this.store.listEvents(wsId).find((e) => e.payload?.field_refs?.includes(state.email_handoff_ref));
    this.contribute(wsId, "human", "submission", { events: [handoffEvent!.id], artifacts: [state.email_handoff_ref], limitations: note ? [`note:${note.slice(0, 200)}`] : [] });
    this.setState(wsId, { email_sent: true });
  }

  /** Learning pass: proposals only. Memory proposals each open a confirm Request. */
  proposeLearning(wsId: string): void {
    const { ws, host } = this.session(wsId);
    if (this.state(wsId).learning_proposed) return;
    if (ws.status !== "active" && ws.status !== "waiting_on_human") throw new UserError(`WorkSession is ${ws.status}.`, 409);
    if (this.pendingRequests(wsId).some((r) => r.requested_action.action !== "confirm_memory")) {
      throw new UserError("Resolve the open Requests before the learning pass.", 409);
    }
    const decision = this.decide(wsId, "propose_learning", `work-session:${wsId}`);
    const reviews = this.store.listRecords(wsId, "Review");
    const reviewEvents = this.store.listEvents(wsId).filter((e) => e.type === "review.recorded").map((e) => e.id);
    const created = this.store.listEvents(wsId)[0].id;
    const cvReviews = reviews.filter((r) => this.store.getRecord("Request", r.target_ref.replace("request:", ""))?.requested_action.action === "accept_cv_version");
    const learningId = newId("learning");
    const lessons = cvReviews.map((r) => `CV review ${r.decision}${r.approval_scope?.allowed_scope?.constraint_refs ? ` (${r.approval_scope.allowed_scope.constraint_refs.join(", ")})` : ""}`);
    const memoryProposals: ProtocolRecord[] = [];
    const facts = host.facts as CandidateFacts;
    if (Object.keys(facts).length) {
      memoryProposals.push({
        id: newId("memory-proposal"),
        work_session_id: wsId,
        proposed_by_actor_id: AGENT_ACTOR_ID,
        proposed_for: "human",
        memory_scope: "scope:candidate-profile",
        memory_type: "candidate_facts",
        content: { facts },
        provenance: [created, "candidate_facts:human_supplied"],
        confidence: 0.9,
        review_required: true,
        status: "pending_review",
        created_at: this.store.nowIso(),
        source_event_refs: [created],
        learning_record_refs: [learningId],
      });
    }
    const narrowed = cvReviews.find((r) => r.decision === "narrow" || r.decision === "needs_revision");
    if (narrowed) {
      memoryProposals.push({
        id: newId("memory-proposal"),
        work_session_id: wsId,
        proposed_by_actor_id: AGENT_ACTOR_ID,
        proposed_for: "pair",
        memory_scope: "scope:future-applications",
        memory_type: "cv_adaptation_preference",
        content: { decision: narrowed.decision, constraint_refs: narrowed.approval_scope?.allowed_scope?.constraint_refs ?? [], required_changes: narrowed.required_changes ?? [] },
        provenance: [`review:${narrowed.id}`],
        confidence: 0.6,
        review_required: true,
        status: "pending_review",
        created_at: this.store.nowIso(),
        source_event_refs: reviewEvents,
        learning_record_refs: [learningId],
      });
    }
    const learning: ProtocolRecord = {
      id: learningId,
      work_session_id: wsId,
      created_by_actor_id: AGENT_ACTOR_ID,
      subject_type: "pair",
      subject_ref: `pair:${HUMAN_WORKER_ID}+${AGENT_WORKER_ID}`,
      lesson_type: "application_preparation_review_pattern",
      source_event_refs: reviewEvents.length ? reviewEvents : [created],
      review_state: "proposed",
      scope: "scope:future-applications",
      created_at: this.store.nowIso(),
      proposed_change: { pattern: lessons.length ? lessons.join("; ") : "No CV review decision recorded in this WorkSession." },
      ...(memoryProposals.length ? { memory_proposal_refs: memoryProposals.map((m) => m.id) } : {}),
    };
    this.store.createLearningRecord(this.wsHeaders(AGENT_ACTOR_ID, wsId), wsId, learning, this.binding(decision));
    for (const proposal of memoryProposals) {
      this.store.createMemoryProposal(this.wsHeaders(AGENT_ACTOR_ID, wsId), wsId, proposal, this.binding(decision));
    }
    this.setState(wsId, { learning_proposed: true });
    for (const proposal of memoryProposals) {
      this.openRequest(wsId, "confirm_memory", `memory-proposal:${proposal.id}`, {
        type: "review",
        reason_code: "memory_requires_confirmation",
        reason_summary: `Proposed ${proposal.memory_type} memory for ${proposal.proposed_for}. Nothing becomes memory until you confirm.`,
        requested_outcome: "HumanWorker confirms or rejects the memory proposal.",
        human_decision_needed: "Should this become durable memory for future WorkSessions?",
        options: [
          { id: "option-confirm", label: "Confirm memory", effect: "Stored as durable memory inside its declared scope.", risk_class: "medium", scope_ref: "scope:durable-memory" },
          { id: "option-reject", label: "Reject", effect: "Nothing is stored.", risk_class: "low", scope_ref: "scope:durable-memory" },
        ],
        default_if_no_response: { action: "do_not_store", reason: "Unconfirmed proposals never become memory.", limitation_ref: "limitation:memory-not-confirmed" },
      });
    }
  }

  private afterMemoryReview(wsId: string, request: ProtocolRecord, review: ProtocolRecord): void {
    const proposalId = String(request.requested_action.target_ref).replace("memory-proposal:", "");
    const proposal = this.store.getRecord("MemoryProposal", proposalId)!;
    const accepted = review.decision === "approve";
    const updated = { ...proposal, status: accepted ? "accepted" : "rejected", review_refs: [review.id] };
    const learning = this.store.listRecords(wsId, "LearningRecord").find((l) => (l.memory_proposal_refs ?? []).includes(proposalId));
    this.store.appendJarvisEvent(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, {
      actor_id: HUMAN_ACTOR_ID,
      type: accepted ? "memory.confirmed" : "memory.rejected",
      payload: { object_type: "memory_proposal", object_id: proposalId, action: accepted ? "accepted" : "rejected", field_refs: [`review:${review.id}`], summary: `HumanWorker ${accepted ? "confirmed" : "rejected"} memory proposal.` },
      writes: () => [
        { objectType: "MemoryProposal", record: updated },
        ...(learning && accepted ? [{ objectType: "LearningRecord" as const, record: { ...learning, review_state: "accepted" } }] : []),
      ],
      afterCommit: () => {
        if (accepted) this.store.writeMemory(updated);
      },
    });
  }

  complete(wsId: string): void {
    const { ws } = this.session(wsId);
    if (ws.status !== "active" && ws.status !== "waiting_on_human") throw new UserError(`WorkSession is ${ws.status}.`, 409);
    if (this.pendingRequests(wsId).length) throw new UserError("Resolve or cancel the open Requests first.", 409);
    if (!this.state(wsId).learning_proposed) this.proposeLearning(wsId);
    if (this.pendingRequests(wsId).length) return; // memory confirmations now pending
    this.reactivateIfClear(wsId);
    this.endWorkSession(wsId, "completed", [], "Objective reached: application package prepared under review.");
  }

  cancel(wsId: string, reason = "HumanWorker cancelled the WorkSession."): void {
    for (const request of this.pendingRequests(wsId)) {
      this.store.appendJarvisEvent(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, {
        actor_id: HUMAN_ACTOR_ID,
        type: "request.closed",
        payload: { object_type: "request", object_id: request.id, action: "cancelled", summary: "Request cancelled with the WorkSession; nothing proceeds." },
        writes: (ctx) => [{ objectType: "Request", record: { ...request, status: "cancelled", resolved_at: ctx.now, closed_by_event_ref: ctx.eventId } }],
      });
    }
    this.endWorkSession(wsId, "cancelled", [], reason);
  }

  private endWorkSession(wsId: string, status: "completed" | "cancelled" | "failed", refs: string[], summary: string): void {
    const ws = this.store.getWorkSession(wsId)!;
    const closures = this.store
      .listRecords(wsId, "Request")
      .map((r) => (r.resolved_by_review_id ? `review:${r.resolved_by_review_id}` : r.closed_by_event_ref ? `request_closure:${r.closed_by_event_ref}` : r.resolved_by_takeover_id ? `takeover:${r.resolved_by_takeover_id}` : null))
      .filter((x): x is string => Boolean(x));
    const learningRefs = this.store.listRecords(wsId, "LearningRecord").map((l) => l.id);
    this.store.appendJarvisEvent(this.wsHeaders(HUMAN_ACTOR_ID, wsId), wsId, {
      actor_id: HUMAN_ACTOR_ID,
      type: `work_session.${status}`,
      status_to: status,
      payload: { object_type: "work_session", object_id: wsId, action: status, field_refs: [...new Set([...refs, ...closures])], summary },
      work_session_patch: {
        evidence_manifest_ref: `evidence-manifest-${wsId}`,
        ...(learningRefs.length ? { learning_record_refs: learningRefs } : {}),
      },
    });
    void ws;
  }

  recordOutcome(wsId: string, input: { outcome: string; note?: string }): ProtocolRecord {
    const { ws } = this.session(wsId);
    if (!["completed", "failed", "cancelled", "closed"].includes(ws.status)) throw new UserError("OutcomeReports arrive after the WorkSession ends.", 409);
    const map: Record<string, string> = { not_submitted: "partial", submitted: "partial", interview: "accepted", offer: "accepted", rejection: "rejected" };
    const outcome = map[input.outcome];
    if (!outcome) throw new UserError("outcome must be not_submitted, submitted, interview, rejection, or offer.");
    const learning = this.store.listRecords(wsId, "LearningRecord");
    if (!learning.length) throw new UserError("This WorkSession has no LearningRecord to attach the outcome to.", 409);
    const report: ProtocolRecord = {
      id: newId("outcome-report"),
      work_session_id: wsId,
      source_ref: `source:${ws.status}-worksession:${wsId}`,
      reporter_ref: "reporter:candidate",
      accepted_by_actor_id: HUMAN_ACTOR_ID,
      outcome,
      learning_record_refs: learning.map((l) => l.id),
      received_at: this.store.nowIso(),
      reporter_actor_id: HUMAN_ACTOR_ID,
      reason: `host_outcome=${input.outcome}${input.note ? `; ${input.note.slice(0, 300)}` : ""}`,
      external_system_ref: "external:employer-response-recorded-by-candidate",
    };
    this.store.submitOutcomeReport(this.nonWsHeaders(HUMAN_ACTOR_ID), report);
    return report;
  }

  // ------------------------------------------------------------- views

  view(wsId: string): ProtocolRecord {
    const { ws, host } = this.session(wsId);
    const state = this.state(wsId);
    const artifact = (ref?: string) => (ref ? this.store.getArtifact(ref)?.content ?? null : null);
    return {
      work_session: ws,
      job_url: host.jobUrl,
      has_master_cv: Boolean(host.masterCv),
      candidate_facts: host.facts,
      lock_epoch: host.lockEpoch,
      events: this.store.listEvents(wsId),
      requests: this.store.listRecords(wsId, "Request"),
      reviews: this.store.listRecords(wsId, "Review"),
      policy_decisions: this.store.listRecords(wsId, "PolicyDecision"),
      contributions: this.store.listRecords(wsId, "Contribution"),
      takeovers: this.store.listRecords(wsId, "Takeover"),
      evidence: this.store.listRecords(wsId, "EvidenceItemRef"),
      learning_records: this.store.listRecords(wsId, "LearningRecord"),
      memory_proposals: this.store.listRecords(wsId, "MemoryProposal"),
      outcome_reports: this.store.listRecords(wsId, "OutcomeReport"),
      artifacts: {
        jd: artifact(state.jd_ref),
        score_sheet: artifact(state.score_ref),
        cv_patches: (state.patch_refs ?? []).map((ref) => ({ ref, patch: artifact(ref) })),
        accepted_cv: artifact(state.accepted_cv_ref),
        email_draft: artifact(state.email_ref),
        email_handoff: artifact(state.email_handoff_ref),
      },
      email_sent: Boolean(state.email_sent),
      learning_proposed: Boolean(state.learning_proposed),
      limitations: state.limitations ?? [],
    };
  }

  listSessions(): ProtocolRecord[] {
    return this.store.listWorkSessions().map((ws) => ({
      id: ws.id,
      status: ws.status,
      revision: ws.revision,
      updated_at: ws.updated_at,
      job_url: this.store.getHostSession(ws.id)?.jobUrl ?? null,
      title: (() => {
        const ref = this.store.getHostSession(ws.id)?.state?.jd_ref;
        return ref ? (this.store.getArtifact(ref)?.content?.title ?? null) : null;
      })(),
    }));
  }
}

export function normalizeFacts(raw: Record<string, unknown>): CandidateFacts {
  const facts: CandidateFacts = {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined);
  if (str(raw.name)) facts.name = str(raw.name);
  if (str(raw.location)) facts.location = str(raw.location);
  if (str(raw.visa)) facts.visa = str(raw.visa);
  const languages = Array.isArray(raw.languages) ? raw.languages : typeof raw.languages === "string" ? raw.languages.split(",") : [];
  const cleaned = languages.map((l) => String(l).trim()).filter(Boolean).slice(0, 12);
  if (cleaned.length) facts.languages = cleaned;
  if (typeof raw.willing_to_relocate === "boolean") facts.willing_to_relocate = raw.willing_to_relocate;
  if (str(raw.other)) facts.other = str(raw.other);
  return facts;
}

export function factsText(facts: CandidateFacts): string {
  return [facts.name, facts.location, facts.visa, ...(facts.languages ?? []), facts.other].filter(Boolean).join("\n");
}

export { JarvisError };
