import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryDatabase } from "../src/store/memory-db.ts";
import { RecordStore } from "../src/store/record-store.ts";
import { HostStore } from "../src/store/host-store.ts";
import { Apply2InterviewService } from "../src/app/service.ts";
import { Assistant } from "../src/app/assistant.ts";
import { docxText, readDocx } from "../src/adapters/docx.ts";
import { cleanJobUrl, vacanciesFromDocx } from "../src/app/vacancy-import.ts";
import { structureJd } from "../src/scoring/jd.ts";
import { scoreFit } from "../src/scoring/score.ts";
import { parseCv } from "../src/scoring/cv.ts";
import { AUTH, FIXTURES, fixture } from "./helpers.ts";

const bytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, "docx", name)));
const SOURCES = [
  { label: "General", text: fixture("ejemplo/cv-general-es.md") },
  { label: "EWM", text: fixture("ejemplo/cv-ewm-es.md") },
  { label: "English", text: fixture("ejemplo/cv-english.md") },
];

test("docx: links list (hyperlinks via relationships) and numbered JD entries", async () => {
  const links = await readDocx(bytes("tabla-enlaces.docx"));
  assert.equal(links.links.length, 2);
  assert.equal(cleanJobUrl(links.links[0]), "https://www.linkedin.com/jobs/view/4100000001/", "tracking query dropped");
  const fromLinks = vacanciesFromDocx(links);
  assert.deepEqual(fromLinks.map((v) => v.key), ["4100000001", "4100000002"]);
  assert.ok(fromLinks.every((v) => v.jd_text === null), "a link alone is not a JD");

  const jds = await readDocx(bytes("descripciones.docx"));
  assert.match(docxText(jds), /^- 3\+ años de experiencia en desarrollo ABAP\.$/m, "Word bullets become '- ' lines");
  const vs = vacanciesFromDocx(jds);
  assert.deepEqual(vs.map((v) => v.key.startsWith("doc-") ? "doc" : v.key), ["4100000001", "4100000002", "doc"]);
  assert.equal(vs[0].company, "Distribución Ejemplo SA");
  assert.equal(vs[2].url, "", "pasted brief has no link");
  assert.ok(vs.every((v) => (v.jd_text ?? "").length >= 200));
});

test("jd: question and colon headings; optional languages are not required", () => {
  const jd = structureJd(
    { url: "", final_url: "", http_status: 0, fetched_at: "", content_type: "", page_title: null, extraction: "human_supplied", json_ld: null,
      text: "Rol\n¿Qué perfil buscamos?\nExperiencia en SAP EWM.\n¿Qué te ofrecemos?\nSeguro médico privado.\nThe amazing you, will have:\nThorough knowledge of English is crucial; active knowledge of Dutch, French and/or German is a great plus." },
    "hash:x",
  );
  assert.deepEqual(jd.must_haves.map((r) => r.text), ["Experiencia en SAP EWM.", "Thorough knowledge of English is crucial; active knowledge of Dutch, French and/or German is a great plus."]);
  const cv = parseCv(fixture("ejemplo/cv-english.md"), "en");
  const sheet = scoreFit(jd, cv, { languages: ["Spanish", "English"] }, { jdSnapshot: "hash:x", masterCv: "hash:y" }, new Date("2026-10-01"));
  const lang = sheet.requirements.find((r) => r.text.startsWith("Thorough"))!;
  assert.equal(lang.status, "met", "English is required; Dutch/French/German are a plus");
  assert.deepEqual(sheet.apply_to_interview_pct.inputs.hard_blockers, []);
});

test("assistant: import links then JDs, prepare all from the document, one-tap approve", async () => {
  const db = new MemoryDatabase();
  const store = new RecordStore(db, { authorize: (a) => a === AUTH });
  const fetched: string[] = [];
  const fetchImpl = (async (url: string) => { fetched.push(String(url)); throw new Error("offline"); }) as typeof fetch;
  const service = new Apply2InterviewService(store, { authorization: AUTH, fetchImpl });
  const assistant = new Assistant(new HostStore(db), service, { fetchImpl });
  assistant.saveProfile({ source_cvs: SOURCES, candidate_facts: { name: "Lucía Ejemplo", languages: ["Español", "Inglés"] } });

  assert.deepEqual(await assistant.importDocx(bytes("tabla-enlaces.docx")), { added: 2, updated: 0, with_jd: 0, total: 2 });
  assert.deepEqual(await assistant.importDocx(bytes("descripciones.docx")), { added: 1, updated: 2, with_jd: 3, total: 3 });
  const leads = await assistant.prepare();
  assert.equal(fetched.length, 0, "JDs came from the document; nothing was fetched");
  assert.ok(leads.every((l) => l.status === "prepared"), JSON.stringify(leads.map((l) => [l.id, l.status, l.note])));
  assert.ok(leads.every((l) => (l.pct ?? 0) >= 50), JSON.stringify(leads.map((l) => l.pct)));
  const view = service.view(leads[0].ws_id!);
  assert.equal(view.evidence.find((e: any) => e.evidence_type === "jd_snapshot")?.trust_label ?? "human_supplied", "human_supplied");

  const { to_open } = await assistant.approveAll();
  assert.equal(to_open.length, 3);
  assert.equal(to_open.filter((o) => o.url).length, 2, "the pasted brief has no link to open");
  const brief = assistant.leads().find((l) => !l.url)!;
  assert.equal(assistant.markSubmitted(brief.id).status, "submitted", "a brief sent by email can still be marked as sent");
  await assert.rejects(assistant.importDocx(new Uint8Array([1, 2, 3])), /docx/);
});
