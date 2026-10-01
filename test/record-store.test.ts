import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createWorkSessionMutationHeaders, validateEventHashChain } from "../src/protocol/jarvis.ts";
import { makeService, fixture, JOB_URL, FACTS, AUTH } from "./helpers.ts";
import { AGENT_ACTOR_ID, HUMAN_ACTOR_ID, POLICY_ID } from "../src/app/participants.ts";
import { normalizedActionHash } from "../src/policy/apply2interview-policy.ts";
import type { RecordStore } from "../src/store/record-store.ts";

const pages = { [JOB_URL]: { body: fixture("jd-public.html") } };

function headers(store: RecordStore, wsId: string, actorId: string, overrides: Record<string, unknown> = {}) {
  const ws = store.getWorkSession(wsId)!;
  return {
    ...createWorkSessionMutationHeaders({
      authorization: AUTH,
      actorId,
      idempotencyKey: `idem-${randomUUID()}`,
      requestTimestamp: store.nowIso(),
      expectedWorkSessionRevision: ws.revision,
      previousEventHash: ws.last_event_hash,
    }),
    ...overrides,
  } as Record<string, any>;
}

function pd(store: RecordStore, wsId: string, action: string, result: string, extra: Record<string, unknown> = {}) {
  const requested = { action, target_ref: "artifact:test", scope_ref: "scope:local-worksession" };
  return {
    id: `pd-${randomUUID().slice(0, 8)}`,
    work_session_id: wsId,
    actor_id: AGENT_ACTOR_ID,
    policy_id: POLICY_ID,
    requested_action: requested,
    normalized_action_hash: normalizedActionHash(requested),
    risk_class: "low",
    result,
    reason: "test",
    created_at: store.nowIso(),
    ...(result === "allow" ? { selected_grant_refs: [`grant:${action}`] } : {}),
    ...extra,
  };
}

async function session() {
  const ctx = makeService(pages);
  const wsId = await ctx.service.startSession({ job_url: JOB_URL, master_cv: fixture("fake-cv.md"), candidate_facts: FACTS });
  return { ...ctx, wsId };
}

const evidenceEvent = (wsId: string) => ({
  actor_id: AGENT_ACTOR_ID,
  type: "evidence.captured",
  payload: { object_type: "evidence_item", object_id: "evidence-x", action: "captured" },
});

test("every WorkSession mutation requires the six Jarvis headers", async () => {
  const { store, wsId } = await session();
  const missing: [string, string][] = [
    ["Jarvis-Protocol-Version", "missing_protocol_version"],
    ["Jarvis-Actor-Id", "missing_actor"],
    ["Jarvis-Idempotency-Key", "missing_idempotency_key"],
    ["Jarvis-Request-Timestamp", "missing_request_timestamp"],
    ["Jarvis-Expected-WorkSession-Revision", "missing_expected_work_session_revision"],
    ["Jarvis-Previous-Event-Hash", "missing_previous_event_hash"],
  ];
  for (const [header, errorId] of missing) {
    const h = headers(store, wsId, AGENT_ACTOR_ID);
    delete h[header];
    assert.throws(() => store.recordPolicyDecision(h, wsId, pd(store, wsId, "score_fit", "allow")), (e: any) => e.errorId === errorId, header);
  }
});

test("stale revision, wrong previous hash, stale timestamp, and bad auth are rejected", async () => {
  const { store, wsId } = await session();
  const ws = store.getWorkSession(wsId)!;
  const decision = () => pd(store, wsId, "score_fit", "allow");
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID, { "Jarvis-Expected-WorkSession-Revision": ws.revision - 1 }), wsId, decision()), (e: any) => e.errorId === "stale_work_session_revision");
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID, { "Jarvis-Previous-Event-Hash": "hash:not-the-last" }), wsId, decision()), (e: any) => e.errorId === "invalid_previous_event_hash");
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID, { "Jarvis-Request-Timestamp": "2020-01-01T00:00:00Z" }), wsId, decision()), (e: any) => e.errorId === "stale_request_timestamp");
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID, { Authorization: "HostAuth wrong" }), wsId, decision()), (e: any) => e.errorId === "unauthorized_actor");
  assert.equal(store.getWorkSession(wsId)!.revision, ws.revision, "rejections never advance the revision");
});

test("idempotent replay returns the original result; key reuse with another payload is rejected", async () => {
  const { store, wsId } = await session();
  const h = headers(store, wsId, AGENT_ACTOR_ID);
  const decision = pd(store, wsId, "score_fit", "allow");
  const first = store.recordPolicyDecision(h, wsId, decision);
  const replay = store.recordPolicyDecision(h, wsId, decision);
  assert.equal(replay.replayed, true);
  assert.equal(replay.event!.event_hash, first.event!.event_hash);
  assert.equal(store.getWorkSession(wsId)!.revision, first.workSession!.revision, "replay appends no event");
  assert.throws(() => store.recordPolicyDecision(h, wsId, { ...decision, reason: "different" }), (e: any) => e.errorId === "duplicate_idempotency_key_mismatch");
});

test("Jarvis-Actor-Id must match the body actor, and actors stay inside their event authority", async () => {
  const { store, wsId } = await session();
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, HUMAN_ACTOR_ID), wsId, pd(store, wsId, "score_fit", "allow")), (e: any) => e.errorId === "actor_body_id_mismatch");
  const review = { id: "review-x", work_session_id: wsId, reviewer_actor_id: AGENT_ACTOR_ID, reviewer_worker_id: "worker-agent-apply2interview", target_ref: "artifact:test", decision: "answer", created_at: store.nowIso() };
  assert.throws(() => store.recordReview(headers(store, wsId, AGENT_ACTOR_ID), wsId, review), (e: any) => e.errorId === "unauthorized_actor", "the agent cannot record Reviews");
});

test("AgentWorker mutations need a prior PolicyDecision that allows the action", async () => {
  const { store, wsId } = await session();
  assert.throws(() => store.appendJarvisEvent(headers(store, wsId, AGENT_ACTOR_ID), wsId, evidenceEvent(wsId)), (e: any) => e.errorId === "missing_policy_decision");

  const denied = pd(store, wsId, "submit_application", "deny", { request_id: "req-x", denied_grant_refs: ["grant:submit_application"] });
  store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, denied);
  assert.throws(
    () => store.appendJarvisEvent(headers(store, wsId, AGENT_ACTOR_ID), wsId, evidenceEvent(wsId), { policyDecisionId: denied.id, action: "submit_application" }),
    (e: any) => e.errorId === "policy_denied",
  );
  // An allow decision for an action the Policy denies is itself rejected.
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, pd(store, wsId, "submit_application", "allow")), (e: any) => e.errorId === "policy_denied");
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, pd(store, wsId, "send_application_email", "allow")), (e: any) => e.errorId === "policy_denied", "sending needs an approved Review");
  // A deny decision without a Request is rejected.
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, pd(store, wsId, "overwrite_master_cv", "deny")), (e: any) => e.errorId === "missing_policy_decision");
});

test("ApprovalScope is single-use and bound to its Request", async () => {
  const { service, store, wsId } = await session();
  const emailRequest = service.view(wsId).requests.find((r: any) => r.requested_action.action === "send_application_email");
  await service.review(wsId, emailRequest.id, { decision: "approve" });
  const review = store.listRecords(wsId, "Review").find((r) => r.target_ref === `request:${emailRequest.id}`)!;
  const again = pd(store, wsId, "send_application_email", "allow", {
    requested_action: emailRequest.requested_action,
    normalized_action_hash: store.getRecord("PolicyDecision", emailRequest.policy_decision_id)!.normalized_action_hash,
    selected_grant_refs: [`approval-scope:${review.id}`],
  });
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, again), (e: any) => e.errorId === "invalid_approval_scope", "max_uses 1 is exhausted");
});

test("Takeover advances the lock epoch and stale agent continuation is rejected", async () => {
  const { store, wsId } = await session();
  const takeover = {
    id: "takeover-test",
    work_session_id: wsId,
    requested_by_actor_id: HUMAN_ACTOR_ID,
    controlling_actor_id: HUMAN_ACTOR_ID,
    affected_scope: { blocking_scope: "artifact", scope_ref: "scope:local-worksession" },
    reason: "human edits",
    lock_epoch: 1,
    state: "human_active",
    created_at: store.nowIso(),
  };
  store.recordTakeover(headers(store, wsId, HUMAN_ACTOR_ID), wsId, takeover);
  assert.equal(store.lockEpoch(wsId), 1);
  assert.throws(
    () => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, pd(store, wsId, "score_fit", "allow"), { lockEpoch: 0 }),
    (e: any) => e.errorId === "stale_takeover_epoch",
  );
  assert.throws(
    () => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, pd(store, wsId, "score_fit", "allow"), { lockEpoch: 1 }),
    (e: any) => e.errorId === "stale_takeover_epoch",
    "the scope is under human control",
  );
  assert.throws(() => store.recordTakeover(headers(store, wsId, HUMAN_ACTOR_ID), wsId, { ...takeover, state: "resumed", resumed_by_actor_id: HUMAN_ACTOR_ID, resolved_at: store.nowIso(), reconciliation_refs: ["x"] }), (e: any) => e.errorId === "invalid_transition", "resume goes through reconciliation_required");
  store.recordTakeover(headers(store, wsId, HUMAN_ACTOR_ID), wsId, { ...takeover, state: "reconciliation_required" });
  assert.throws(() => store.recordTakeover(headers(store, wsId, HUMAN_ACTOR_ID), wsId, { ...takeover, state: "resumed", resumed_by_actor_id: HUMAN_ACTOR_ID, resolved_at: store.nowIso(), reconciliation_refs: [] }), (e: any) => e.errorId === "missing_reconciliation_refs");
});

test("completion is rejected while Requests are unresolved; terminal sessions reject new work", async () => {
  const { service, store, wsId } = await session();
  assert.throws(
    () => store.appendJarvisEvent(headers(store, wsId, HUMAN_ACTOR_ID), wsId, { actor_id: HUMAN_ACTOR_ID, type: "work_session.completed", status_to: "completed", payload: { object_type: "work_session", object_id: wsId, action: "completed", field_refs: ["x"] } }),
    (e: any) => e.errorId === "missing_blocked_scope_resolution_refs",
  );
  service.cancel(wsId);
  assert.equal(store.getWorkSession(wsId)!.status, "cancelled");
  assert.ok(store.listRecords(wsId, "Request").every((r) => r.status === "cancelled" && r.closed_by_event_ref));
  assert.throws(() => store.recordPolicyDecision(headers(store, wsId, AGENT_ACTOR_ID), wsId, pd(store, wsId, "score_fit", "allow")), (e: any) => e.errorId === "sealed_work_session_mutation");
  assert.equal(validateEventHashChain(store.listEvents(wsId)).valid, true);
});

test("memory cannot be confirmed without a HumanWorker approve Review", async () => {
  const { service, store, wsId } = await session();
  for (const r of service.view(wsId).requests) {
    await service.review(wsId, r.id, { decision: "deny" });
  }
  service.proposeLearning(wsId);
  const proposal = store.listRecords(wsId, "MemoryProposal")[0];
  assert.equal(proposal.status, "pending_review");
  assert.throws(
    () => store.appendJarvisEvent(headers(store, wsId, HUMAN_ACTOR_ID), wsId, {
      actor_id: HUMAN_ACTOR_ID,
      type: "memory.confirmed",
      payload: { object_type: "memory_proposal", object_id: proposal.id, action: "accepted" },
      writes: () => [{ objectType: "MemoryProposal", record: { ...proposal, status: "accepted", review_refs: ["review-that-does-not-exist"] } }],
    }),
    (e: any) => e.errorId === "model_self_confirmed_memory",
  );
  assert.equal(store.listMemory().length, 0);
});
