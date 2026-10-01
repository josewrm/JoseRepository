import { test } from "node:test";
import assert from "node:assert/strict";
import { makeService, fixture } from "./helpers.ts";
import { TARGET_PCT, type OutgoingEmail } from "../src/app/service.ts";
import { openDatabase } from "../src/store/db.ts";
import { RecordStore } from "../src/store/record-store.ts";
import { Apply2InterviewService } from "../src/app/service.ts";
import { fakeFetch, AUTH } from "./helpers.ts";

const URL = "https://empleo.example.test/logistica-norte/sap-ewm";
const pages = { [URL]: { body: fixture("ejemplo/oferta-ewm.html") } };
const SOURCES = [
  { label: "General", text: fixture("ejemplo/cv-general-es.md") },
  { label: "EWM", text: fixture("ejemplo/cv-ewm-es.md") },
  { label: "English", text: fixture("ejemplo/cv-english.md") },
];
const FACTS = { name: "Lucía Ejemplo", email: "lucia.ejemplo@example.test", location: "Valencia, España", visa: "Ciudadana UE", languages: ["Español", "Inglés"], willing_to_relocate: true };

test("three source CVs: each is adapted and evaluated; the best beats its own baseline without new facts", async () => {
  const { service } = makeService(pages);
  const wsId = await service.startSession({ job_url: URL, source_cvs: SOURCES, candidate_facts: FACTS });
  const view = service.view(wsId);
  assert.equal(view.artifacts.jd.language, "es");
  assert.ok(view.full_jd_text.includes("Permiso de trabajo en la UE"), "full JD text is kept");
  const evaluation = view.evaluation;
  assert.equal(evaluation.sources.length, 3);
  const best = evaluation.sources.find((s: any) => s.label === evaluation.best_label);
  assert.ok(best.after.pct >= best.before.pct, "adaptation never lowers the score");
  assert.ok(evaluation.sources.some((s: any) => s.upgrade_pts > 0), "facts from the other CVs raise at least one version");
  assert.equal(evaluation.target_pct, TARGET_PCT);
  for (const s of evaluation.sources) assert.match(s.filename, /^CV_Lucia_Ejemplo_Logistica_Norte_Desarrollador_a_SAP_EWM_ABAP_/);

  // The General CV gains EWM bullets only under the same role (Almacenes Delta), never under Consultora Sur.
  const general = view.artifacts.cv_patches.find((p: any) => p.patch.source_label === "General").patch;
  const delta = general.sections.find((x: any) => x.after.includes("Almacenes Delta"));
  assert.ok(delta && delta.after.includes("acciones PPF") && delta.sources_used.includes("EWM"));
  const sur = general.sections.find((x: any) => x.after.includes("Consultora Sur"));
  assert.ok(!sur || !sur.after.includes("PPF"));
  // English bullets never enter a Spanish CV.
  assert.ok(!general.sections.some((x: any) => x.after.includes("Built RF transactions")));
});

test("one click: approve the recommended CV and the email; the host sends only after that click", async () => {
  const sent: OutgoingEmail[] = [];
  const db = openDatabase(":memory:");
  const store = new RecordStore(db, { authorize: (a) => a === AUTH });
  const service = new Apply2InterviewService(store, {
    authorization: AUTH,
    fetchImpl: fakeFetch(pages),
    mailer: async (message) => {
      sent.push(message);
      return { id: "<msg-1@test>" };
    },
  });
  const wsId = await service.startSession({ job_url: URL, source_cvs: SOURCES, candidate_facts: FACTS });
  assert.equal(sent.length, 0, "nothing is sent before the human clicks");
  const form = service.view(wsId).form;
  assert.equal(form.fields.find((f: any) => f.key === "email").value, "lucia.ejemplo@example.test");
  assert.equal(form.fields.find((f: any) => f.key === "recipient").value, "talento@logisticanorte.example");

  await service.approveAndSend(wsId);
  const view = service.view(wsId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "talento@logisticanorte.example");
  assert.match(sent[0].attachments[0].filename, /^CV_Lucia_Ejemplo_Logistica_Norte_.*\.md$/);
  assert.doesNotMatch(sent[0].body, /%|puntuaci/i);
  assert.equal(view.email_sent, true);
  assert.equal(view.email_receipt.sent_by_host, true);
  assert.equal(view.reviews.length, 2, "one click recorded two human Reviews");
  assert.ok(view.reviews.every((r: any) => r.decision === "approve" && r.approval_scope.max_uses === 1));
  assert.equal(view.work_session.status, "active");
});

test("the human can pick another adapted version; it narrows the approval to that version", async () => {
  const { service } = makeService(pages);
  const wsId = await service.startSession({ job_url: URL, source_cvs: SOURCES, candidate_facts: FACTS });
  const view = service.view(wsId);
  const other = view.evaluation.sources.find((s: any) => s.label !== view.evaluation.best_label);
  const request = view.requests.find((r: any) => r.requested_action.action === "accept_cv_version");
  await service.review(wsId, request.id, { decision: "approve", version_ref: other.patch_ref });
  const after = service.view(wsId);
  assert.equal(after.artifacts.accepted_cv.source_label, other.label);
  const review = after.reviews[0];
  assert.equal(review.decision, "narrow");
  assert.ok(review.approval_scope.allowed_scope.constraint_refs.includes(`cv_version:${other.patch_ref}`));
});

test("a pasted job description needs no fetch", async () => {
  const { service } = makeService({});
  const text = fixture("ejemplo/oferta-ewm.html").match(/"description":"([\s\S]*?)"}/)![1].replace(/<[^>]+>/g, "\n");
  const wsId = await service.startSession({ jd_text: text, source_cvs: SOURCES, candidate_facts: FACTS });
  const view = service.view(wsId);
  assert.equal(view.artifacts.jd.source.extraction, "human_supplied");
  assert.ok(view.evaluation);
});
