import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateEventHashChain } from "../src/protocol/jarvis.ts";
import { makeService, fixture, JOB_URL, LOGIN_URL, FACTS } from "./helpers.ts";
import { exportEvidencePack } from "../src/export/evidence-export.ts";
import { validatePack } from "../scripts/validate-export.ts";
import { HUMAN_ACTOR_ID } from "../src/app/participants.ts";

const pages = {
  [JOB_URL]: { body: fixture("jd-public.html") },
  [LOGIN_URL]: { body: fixture("jd-login.html") },
};

test("vertical slice: link in -> JD evidence -> section patch -> percentage -> email Request waiting for Review", async () => {
  const { service, store } = makeService(pages);
  const wsId = await service.startSession({ job_url: JOB_URL, master_cv: fixture("fake-cv.md"), candidate_facts: FACTS });
  const view = service.view(wsId);

  assert.equal(view.work_session.status, "waiting_on_human");
  assert.equal(view.artifacts.jd.title, "Senior Backend Engineer");
  assert.ok(view.evidence.some((e: any) => e.evidence_type === "jd_snapshot"));
  assert.ok(view.evidence.some((e: any) => e.evidence_type === "score_sheet"));
  assert.ok(view.evidence.some((e: any) => e.evidence_type === "cv_section_diff"));
  assert.ok(view.evidence.some((e: any) => e.evidence_type === "email_draft"));

  const pct = view.artifacts.score_sheet.apply_to_interview_pct;
  assert.equal(pct.label, "heuristic_v1");
  assert.ok(pct.value <= 49, "missing German (a must-have language) caps the percentage");

  const pending = view.requests.filter((r: any) => r.status === "pending");
  const emailRequest = pending.find((r: any) => r.requested_action.action === "send_application_email");
  assert.ok(emailRequest, "email send is a Request");
  assert.equal(emailRequest.blocking_scope, "external_send");
  const emailDecision = store.getRecord("PolicyDecision", emailRequest.policy_decision_id)!;
  assert.equal(emailDecision.result, "review_required");

  // Every agent mutation follows a PolicyDecision recorded earlier in the chain.
  const events = store.listEvents(wsId);
  assert.equal(validateEventHashChain(events).valid, true);
  assert.equal(events.length, view.work_session.revision);
  const firstPd = events.findIndex((e) => e.type === "policy_decision.recorded");
  const firstAgentWork = events.findIndex((e) => e.actor_id.startsWith("actor-agent") && e.type !== "policy_decision.recorded");
  assert.ok(firstPd >= 0 && firstPd < firstAgentWork);

  // Email never carries the score or percentage.
  const body: string = view.artifacts.email_draft.body;
  assert.ok(!body.includes(`${pct.value}%`));
  assert.ok(!/score|percentage|heuristic/i.test(body));
});

test("full loop: approve CV + email, learning, complete, export validates with the Jarvis CLI, OutcomeReport", async () => {
  const { service, store } = makeService(pages);
  const wsId = await service.startSession({ job_url: JOB_URL, master_cv: fixture("fake-cv.md"), candidate_facts: FACTS });
  let view = service.view(wsId);
  const cvRequest = view.requests.find((r: any) => r.requested_action.action === "accept_cv_version");
  const emailRequest = view.requests.find((r: any) => r.requested_action.action === "send_application_email");

  await service.review(wsId, cvRequest.id, { decision: "narrow", section_ids: ["skills", "experience-1"] });
  view = service.view(wsId);
  assert.equal(view.work_session.status, "waiting_on_human", "email Request still blocks its scope");
  assert.deepEqual(view.artifacts.accepted_cv.accepted_section_ids, ["skills", "experience-1"]);
  assert.ok(view.artifacts.accepted_cv.text.includes("Backend developer focused on reliable APIs. I build"), "summary stays verbatim when not accepted");

  // Email can only be marked sent after approval.
  assert.throws(() => service.markEmailSent(wsId), /approved/);
  await service.review(wsId, emailRequest.id, { decision: "approve" });
  view = service.view(wsId);
  assert.equal(view.work_session.status, "active");
  assert.equal(view.artifacts.email_handoff.sent_by_host, false);
  service.markEmailSent(wsId);

  service.complete(wsId);
  view = service.view(wsId);
  assert.equal(view.work_session.status, "waiting_on_human", "memory proposals wait for confirmation");
  const memoryRequests = view.requests.filter((r: any) => r.status === "pending");
  assert.equal(memoryRequests.length, 2);
  await service.review(wsId, memoryRequests[0].id, { decision: "approve" });
  await service.review(wsId, memoryRequests[1].id, { decision: "deny" });
  assert.equal(store.listMemory().length, 1, "only the confirmed proposal became memory");

  service.complete(wsId);
  view = service.view(wsId);
  assert.equal(view.work_session.status, "completed");

  const out = mkdtempSync(join(tmpdir(), "a2i-export-"));
  const pack = exportEvidencePack(store, wsId, out, HUMAN_ACTOR_ID);
  assert.equal(pack.manifest.event_chain_root, view.work_session.last_event_hash);
  const types = pack.manifest.evidence_item_refs.map((e: any) => e.evidence_type);
  for (const t of ["jd_snapshot", "cv_section_diff", "score_sheet", "email_draft"]) assert.ok(types.includes(t), t);
  const packText = JSON.stringify(pack.files);
  assert.ok(!packText.includes("test-token"));

  const results = validatePack(pack.dir);
  const failures = results.filter((r) => !r.ok);
  assert.deepEqual(failures, [], failures.map((f) => `${f.command} ${f.file}\n${f.output}`).join("\n"));

  const report = service.recordOutcome(wsId, { outcome: "interview", note: "Recruiter call booked" });
  assert.equal(report.outcome, "accepted");
  assert.equal(store.getWorkSession(wsId)!.last_event_hash, view.work_session.last_event_hash, "OutcomeReport does not mutate the sealed WorkSession");
});

test("login-walled page: no JD is invented; a context Request asks the human", async () => {
  const { service, store } = makeService(pages);
  const wsId = await service.startSession({ job_url: LOGIN_URL, master_cv: fixture("fake-cv.md"), candidate_facts: FACTS });
  const view = service.view(wsId);
  assert.equal(view.work_session.status, "waiting_on_human");
  assert.equal(view.artifacts.jd, null);
  assert.equal(view.artifacts.score_sheet, null);
  const request = view.requests[0];
  assert.equal(request.type, "context");
  assert.equal(request.requested_action.action, "use_human_supplied_jd");
  assert.equal(request.reason_code, "jd_login_wall");
  assert.ok(view.evidence.some((e: any) => e.evidence_type === "jd_fetch_failure"));

  // Human answers with the JD text; work continues.
  const jdText = fixture("jd-public.html").match(/"description":"([\s\S]*?)"}/)![1].replace(/<[^>]+>/g, "\n");
  await service.review(wsId, request.id, { decision: "answer", jd_text: jdText });
  const after = service.view(wsId);
  assert.equal(after.artifacts.jd.source.extraction, "human_supplied");
  assert.ok(after.artifacts.score_sheet);
  assert.ok(store.listRecords(wsId, "Request").some((r) => r.requested_action.action === "send_application_email"));
});

test("CV takeover: human edits pass the truth guard, the lock epoch advances, and invented facts are refused", async () => {
  const { service, store } = makeService(pages);
  const wsId = await service.startSession({ job_url: JOB_URL, master_cv: fixture("fake-cv.md"), candidate_facts: FACTS });
  const cvRequest = service.view(wsId).requests.find((r: any) => r.requested_action.action === "accept_cv_version");
  await assert.rejects(
    service.review(wsId, cvRequest.id, { decision: "takeover", edited_sections: { summary: "## Summary\nSenior engineer with Kubernetes and 10 years at Google." } }),
    /cvs_best_version rejected/,
  );
  // The refused edit changed no protocol state.
  assert.equal(store.listRecords(wsId, "Takeover").length, 0);
  assert.equal(store.getRecord("Request", cvRequest.id)!.status, "pending");
  const ws2 = wsId;
  const req2 = cvRequest;
  const epochBefore = store.lockEpoch(ws2);
  await service.review(ws2, req2.id, { decision: "takeover", edited_sections: { summary: "## Summary\nBackend developer: Python services with Django and PostgreSQL, reliable APIs, mentoring." } });
  const view = service.view(ws2);
  assert.equal(store.lockEpoch(ws2), epochBefore + 1);
  assert.equal(view.takeovers[0].state, "resumed");
  assert.ok(view.takeovers[0].reconciliation_refs.length > 0);
  assert.equal(view.requests.find((r: any) => r.id === req2.id).status, "takeover");
  assert.ok(view.artifacts.accepted_cv.text.includes("mentoring."));
});
