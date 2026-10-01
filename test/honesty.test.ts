import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { snapshotFromHtml } from "../src/adapters/job-link.ts";
import { structureJd } from "../src/scoring/jd.ts";
import { parseCv, experienceYears } from "../src/scoring/cv.ts";
import { scoreFit } from "../src/scoring/score.ts";
import { applyPatch, buildCvPatch } from "../src/adapt/section-adapter.ts";
import { TruthGuardError, checkTruth } from "../src/adapt/truth-guard.ts";
import { applyToInterviewPct, band } from "../src/scoring/percentage.ts";
import { EmailGuardError, assertNoScore, draftEmail } from "../src/email/drafter.ts";
import { buildPolicyRecord, evaluate } from "../src/policy/apply2interview-policy.ts";

const NOW = new Date("2026-10-01T00:00:00Z");
const FACTS = { location: "Valencia, Spain", visa: "EU citizen", languages: ["Spanish", "English"] };

function pipeline() {
  const outcome = snapshotFromHtml(fixture("jd-public.html"), { url: "https://x.test/j", finalUrl: "https://x.test/j", status: 200, contentType: "text/html", fetchedAt: NOW.toISOString() });
  assert.ok(outcome.ok);
  const jd = structureJd(outcome.snapshot, "hash:jd");
  const masterText = fixture("fake-cv.md");
  const cv = parseCv(masterText, "en");
  const score = scoreFit(jd, cv, FACTS, { jdSnapshot: "hash:jd", masterCv: "hash:cv" }, NOW);
  const patch = buildCvPatch(cv, jd, score, { hashes: { masterCv: "hash:cv", jdSnapshot: "hash:jd" } });
  return { jd, cv, masterText, score, patch };
}

test("GOLDEN: a fake CV does not gain fake skills or years", () => {
  const { jd, cv, masterText, score, patch } = pipeline();
  // The JD asks for things the CV does not have.
  assert.ok(jd.keywords.includes("Kubernetes") && jd.keywords.includes("AWS") && jd.seniority.min_years === 7);
  const adapted = applyPatch(cv, patch, patch.sections.map((s) => s.section_id));
  for (const fake of [/kubernetes/i, /\bk8s\b/i, /\baws\b/i, /certified/i, /kafka/i, /\b7\+? years\b/i, /german/i, /senior backend engineer/i, /northwind/i]) {
    assert.doesNotMatch(adapted, fake, `adapted CV gained ${fake}`);
  }
  // Same employers, dates and numbers as the master CV.
  const numbers = (text: string) => (text.match(/\d+%?/g) ?? []).sort();
  assert.deepEqual(numbers(adapted), numbers(masterText));
  assert.equal(experienceYears(parseCv(adapted, "en"), NOW), experienceYears(cv, NOW));
  for (const section of patch.sections) {
    assert.equal(section.invented, false);
    assert.ok(cv.sections.some((s) => section.before.includes(s.lines.join("\n"))), `${section.section_id} before is verbatim`);
  }
  // Unchanged sections are copied as-is.
  for (const id of patch.unchanged_section_ids) {
    const original = cv.sections.find((s) => s.id === id)!;
    assert.ok(adapted.includes(original.lines.join("\n")), id);
  }
  // Missing requirements stay missing in the score, with no evidence quotes.
  const kube = score.requirements.find((r) => r.text.includes("Kubernetes"))!;
  assert.equal(kube.status, "not_met");
  assert.deepEqual(kube.evidence_quotes, []);
  const years = score.requirements.find((r) => r.text.startsWith("7+ years"))!;
  assert.equal(years.status, "not_met");
});

test("adapted sections touch only summary, skills, and 2-4 experience roles", () => {
  const { patch } = pipeline();
  const ids = patch.sections.map((s) => s.section_id);
  assert.ok(ids.every((id) => id === "summary" || id === "skills" || /^experience-\d+$/.test(id)));
  assert.ok(ids.filter((id) => id.startsWith("experience-")).length <= 4);
  for (const s of patch.sections) {
    assert.ok(s.jd_requirements_addressed.length > 0);
    assert.ok(s.evidence_quotes.length > 0);
  }
});

test("truth guard hard-fails on invented employers, tools, numbers, and titles", () => {
  const master = fixture("fake-cv.md");
  const cases = [
    "- Built REST APIs in Django on Kubernetes for warehouse scanning used by 40 sites.",
    "- Built REST APIs in Django for warehouse scanning used by 400 sites.",
    "Staff Engineer — Google\nMar 2023 – Present",
    "Relevant to this role: Python, Kubernetes.",
    "Relevant to this role: Python, 10 years.",
    "- AWS Certified Solutions Architect.",
  ];
  for (const after of cases) {
    assert.throws(() => checkTruth([{ section_id: "experience-1", after }], master, ""), TruthGuardError, after);
  }
  // Reordering master lines and list items passes.
  checkTruth([{ section_id: "skills", after: "## Skills\nTools: Redis, Django, PostgreSQL, Git, Docker\nLanguages: Python, SQL, JavaScript" }], master, "");
});

test("fit score and percentage are computed from the master CV, not the adapted CV", () => {
  const { jd, cv, score, patch } = pipeline();
  const adapted = parseCv(applyPatch(cv, patch, patch.sections.map((s) => s.section_id)), "en");
  const rescored = scoreFit(jd, adapted, FACTS, { jdSnapshot: "hash:jd", masterCv: "hash:cv" }, NOW);
  assert.equal(rescored.fit_score.value, score.fit_score.value, "reordering cannot raise the fit score");
  assert.equal(rescored.apply_to_interview_pct.value, score.apply_to_interview_pct.value);
  assert.equal(score.computed_from, "master_cv_and_candidate_facts");
});

test("heuristic_v1 formula, bands, and the hard-blocker cap", () => {
  const all = applyToInterviewPct({ must_have_coverage: 1, seniority_match: 1, domain_match: 1, impact_evidence: 1, ats_keyword_coverage: 1, constraint_fit: 1, hard_blockers: [] });
  // As specified, the weights sum to 90: base 8 + 28 + 12 + 12 + 10 + 8 + 12.
  assert.equal(all.value, 90);
  const none = applyToInterviewPct({ must_have_coverage: 0, seniority_match: 0, domain_match: 0, impact_evidence: 0, ats_keyword_coverage: 0, constraint_fit: 0, hard_blockers: [] });
  assert.equal(none.value, 8);
  const blocked = applyToInterviewPct({ must_have_coverage: 1, seniority_match: 1, domain_match: 1, impact_evidence: 1, ats_keyword_coverage: 1, constraint_fit: 1, hard_blockers: ["Missing legal must-have"] });
  assert.equal(blocked.value, 39); // 90 - 51; the 49 cap is a backstop
  assert.equal(blocked.band, "stretch");
  const mid = applyToInterviewPct({ must_have_coverage: 0.5, seniority_match: 0.5, domain_match: 0.5, impact_evidence: 0.5, ats_keyword_coverage: 0.5, constraint_fit: 0.5, hard_blockers: [] });
  assert.equal(mid.value, 49); // 8 + 0.5 * (28 + 12 + 12 + 10 + 8 + 12)
  assert.equal(mid.label, "heuristic_v1");
  assert.deepEqual([band(70), band(69), band(50), band(49), band(30), band(29)], ["strong", "solid", "solid", "stretch", "stretch", "weak_or_blocked"]);
});

test("a missing legal must-have (sponsorship needed, none offered) is a hard blocker", () => {
  const { jd, cv } = pipeline();
  const score = scoreFit(jd, cv, { languages: ["Spanish", "English", "German"], visa: "I need visa sponsorship", willing_to_relocate: true }, { jdSnapshot: "h", masterCv: "h" }, NOW);
  assert.ok(score.apply_to_interview_pct.inputs.hard_blockers.some((b) => b.includes("legal")));
  assert.ok(score.apply_to_interview_pct.value <= 49);
});

test("email draft: posting language, verbatim highlights, never the score", () => {
  const { jd, score } = pipeline();
  const draft = draftEmail(jd, score, FACTS, "Alex Example");
  assert.equal(draft.language, "en");
  assert.equal(draft.status, "draft");
  assert.doesNotMatch(draft.body, /score|percentage|heuristic/i);
  assert.ok(!draft.body.includes(`${score.apply_to_interview_pct.value}%`));
  assert.throws(() => assertNoScore({ subject: "x", body: `My fit is ${score.fit_score.value}%` }, score), EmailGuardError);
  assert.throws(() => assertNoScore({ subject: "x", body: "Your heuristic says I am strong" }, score), EmailGuardError);
  const spanish = draftEmail({ ...jd, language: "es" }, score, FACTS, "Alex Example");
  assert.match(spanish.subject, /^Candidatura/);
});

test("policy: may fetch/score/propose/draft; may not send, submit, or overwrite the master CV", () => {
  const policy = buildPolicyRecord({ id: "p", ownerWorkerId: "w", createdByActorId: "a", createdAt: NOW.toISOString() });
  for (const action of ["fetch_public_jd", "score_fit", "propose_cv_section_edits", "draft_application_email"]) assert.equal(evaluate(policy, action).result, "allow", action);
  assert.equal(evaluate(policy, "send_application_email").result, "review_required");
  for (const action of ["submit_application", "overwrite_master_cv", "fetch_authenticated_jd"]) assert.equal(evaluate(policy, action).result, "deny", action);
  assert.equal(evaluate(policy, "delete_everything").result, "deny", "uncovered actions deny");
});

test("login walls and empty pages are failures, never a JD", () => {
  const meta = { url: "u", finalUrl: "u", status: 200, contentType: "text/html", fetchedAt: NOW.toISOString() };
  const login = snapshotFromHtml(fixture("jd-login.html"), meta);
  assert.equal(login.ok, false);
  assert.equal(!login.ok && login.reason, "login_wall");
  const empty = snapshotFromHtml("<html><body><p>Loading…</p></body></html>", meta);
  assert.equal(!empty.ok && empty.reason, "empty");
});

test("email without a JD title uses a visible placeholder, not an invented title", () => {
  const { jd, score } = pipeline();
  const draft = draftEmail({ ...jd, title: null }, score, FACTS, "Alex Example");
  assert.match(draft.subject, /\[job title\]/);
  assert.doesNotMatch(draft.body, /the the/);
});
