import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/store/db.ts";
import { MemoryDatabase } from "../src/store/memory-db.ts";
import { RecordStore } from "../src/store/record-store.ts";
import { HostStore } from "../src/store/host-store.ts";
import { Apply2InterviewService } from "../src/app/service.ts";
import { Assistant } from "../src/app/assistant.ts";
import { parseCommand } from "../src/app/commands.ts";
import { linkedInJobId, searchUrl, snapshotFromLinkedInDetail } from "../src/adapters/job-search.ts";
import { parseJobCards } from "../vendor/ai-job-search/linkedin-search/helpers.ts";
import { handleApi } from "../src/server/routes.ts";
import { AUTH, fixture } from "./helpers.ts";

const IDS = ["4100000001", "4100000002", "4100000003", "4100000004"];
const SOURCES = [
  { label: "General", text: fixture("ejemplo/cv-general-es.md") },
  { label: "EWM", text: fixture("ejemplo/cv-ewm-es.md") },
  { label: "English", text: fixture("ejemplo/cv-english.md") },
];
const FACTS = { name: "Lucía Ejemplo", email: "lucia.ejemplo@example.test", location: "Valencia, España", visa: "Ciudadana UE", languages: ["Español", "Inglés"] };

/** LinkedIn guest endpoints served from fixtures; every request is logged. */
function linkedInFetch(log: string[], { searchDown = false } = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    log.push(url);
    if (url.includes("/seeMoreJobPostings/search")) {
      if (searchDown) throw new Error("offline");
      return new Response(fixture("linkedin/search.html"), { status: 200, headers: { "content-type": "text/html" } });
    }
    const id = /jobPosting\/(\d+)$/.exec(url)?.[1];
    if (id && IDS.includes(id)) return new Response(fixture(`linkedin/detail-${id}.html`), { status: 200, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

function makeAssistant(backend: "sqlite" | "memory" = "sqlite", opts: { searchDown?: boolean; examples?: boolean } = {}) {
  const log: string[] = [];
  const db = backend === "memory" ? new MemoryDatabase() : openDatabase(":memory:");
  const store = new RecordStore(db, { authorize: (a) => a === AUTH });
  const fetchImpl = linkedInFetch(log, opts);
  const service = new Apply2InterviewService(store, { authorization: AUTH, fetchImpl });
  const exampleLeads = opts.examples ? parseJobCards(fixture("linkedin/search.html")) : [];
  const assistant = new Assistant(new HostStore(db), service, { fetchImpl, exampleLeads });
  return { assistant, service, store, log };
}

test("commands: Spanish, Portuguese and English intents", () => {
  assert.deepEqual(parseCommand("Busca SAP EWM en Madrid"), { kind: "search", query: "SAP EWM", location: "Madrid" });
  assert.deepEqual(parseCommand("procurar empregos de SAP EWM em Lisboa"), { kind: "search", query: "SAP EWM", location: "Lisboa" });
  assert.deepEqual(parseCommand("search for ABAP developer"), { kind: "search", query: "ABAP developer" });
  assert.equal(parseCommand("Jarvis, enviar todos").kind, "approve_all");
  assert.equal(parseCommand("prepara todos").kind, "prepare_all");
  assert.equal(parseCommand("¿estado?").kind, "status");
  assert.equal(parseCommand("abre empleos").kind, "show_jobs");
  assert.deepEqual(parseCommand("mostrar perfil"), { kind: "open", page: "perfil" });
  assert.equal(parseCommand("hola").kind, "unknown");
});

test("job search: guest search URL and card/detail parsing from ai-job-search", () => {
  const url = new URL(searchUrl({ query: "SAP EWM", location: "Madrid", jobage: 7, remote: "hybrid" }));
  assert.equal(url.searchParams.get("keywords"), "SAP EWM");
  assert.equal(url.searchParams.get("f_TPR"), "r604800");
  assert.equal(url.searchParams.get("f_WT"), "3");
  const cards = parseJobCards(fixture("linkedin/search.html"));
  assert.deepEqual(cards.map((c) => c.id), IDS);
  assert.equal(linkedInJobId(cards[0].url), IDS[0]);
  assert.equal(linkedInJobId("https://www.linkedin.com/jobs/search/?currentJobId=4100000002&keywords=x"), IDS[1]);
  const snap = snapshotFromLinkedInDetail(fixture(`linkedin/detail-${IDS[0]}.html`), IDS[0], { url: cards[0].url, finalUrl: "x", status: 200, fetchedAt: "t" })!;
  assert.match(snap.text, /^- 3\+ años de experiencia en desarrollo ABAP\.$/m, "bullets keep their own lines");
  assert.equal(snap.json_ld?.company, "Distribución Ejemplo SA");
  assert.equal(snapshotFromLinkedInDetail(fixture(`linkedin/detail-${IDS[3]}.html`), IDS[3], { url: "u", finalUrl: "f", status: 200, fetchedAt: "t" }), null, "a stub description is not a JD");
});

for (const backend of ["sqlite", "memory"] as const) {
  test(`assistant (${backend}): search -> prepare all -> one-tap approve -> human submits`, async () => {
    const { assistant, service, store, log } = makeAssistant(backend);
    assistant.saveProfile({ source_cvs: SOURCES, candidate_facts: FACTS, search: { location: "España" } });
    assert.ok(assistant.profileTerms().includes("EWM"));

    const found = await assistant.search({ query: "SAP EWM" });
    assert.equal(found.length, 4);
    assert.ok(found.every((l) => l.status === "found" && !l.ws_id));
    assert.ok(found[0].relevance > 0);

    const prepared = await assistant.prepare();
    const byId = Object.fromEntries(prepared.map((l) => [l.id, l]));
    for (const id of IDS.slice(0, 3)) {
      assert.equal(byId[id].status, "prepared", id);
      assert.ok((byId[id].pct ?? 0) >= 50, `${id} reaches 50%: ${byId[id].pct}`);
    }
    assert.equal(byId[IDS[3]].status, "needs_jd", "stub description -> Request, no invented JD");
    // JD came from the public guest endpoint, never from a logged-in page.
    assert.ok(log.every((u) => u.includes("/jobs-guest/")));

    const before = store.listWorkSessions().length;
    const { to_open, leads } = await assistant.approveAll();
    assert.equal(to_open.length, 3);
    assert.ok(to_open.every((o) => o.url.includes("linkedin.com/jobs/view/")));
    assert.equal(store.listWorkSessions().length, before);
    for (const lead of leads.filter((l) => l.status === "approved")) {
      const view = service.view(lead.ws_id!);
      const reviews = view.reviews as any[];
      assert.ok(reviews.some((r) => r.decision === "approve"), "approval is a HumanWorker Review");
      assert.equal(view.email_sent, false, "nothing is sent");
      assert.equal(view.external_submission, null, "nothing is submitted");
    }

    const done = assistant.markSubmitted(IDS[0]);
    assert.equal(done.status, "submitted");
    const contributions = service.view(done.ws_id!).contributions as any[];
    assert.ok(contributions.some((c) => c.contribution_type === "submission" && c.contributor_type === "human"));
    assert.equal(assistant.summary().submitted, 1);
    assert.throws(() => assistant.markSubmitted(IDS[3]), /CV/);
  });
}

test("assistant: example leads when live search is unavailable, and the command route", async () => {
  const { assistant, service } = makeAssistant("memory", { searchDown: true, examples: true });
  const deps = { service, assistant, exportPack: () => { throw new Error("unused"); } };
  const call = (method: string, pathname: string, body: unknown = {}) => handleApi(deps, { method, pathname, headers: {}, body });

  let res: any = await call("POST", "/api/assistant/command", { text: "busca SAP EWM en Madrid" });
  assert.equal(res.status, 200);
  assert.equal(res.body.page, "empleos");
  assert.ok(res.body.leads.every((l: any) => l.example));
  assert.match(res.body.reply, /ejemplos/);

  res = await call("POST", "/api/assistant/command", { text: "prepara todos" });
  assert.equal(res.status, 409, "no CVs in the profile yet");

  res = await call("POST", "/api/profile", { source_cvs: SOURCES, candidate_facts: FACTS });
  assert.equal(res.body.profile.sources.length, 3);
  res = await call("POST", "/api/assistant/command", { text: "prepara todos" });
  assert.equal(res.body.summary.prepared, 3);
  res = await call("POST", "/api/assistant/command", { text: "enviar todos easy apply" });
  assert.equal(res.body.intent.kind, "approve_all");
  assert.equal(res.body.to_open.length, 3);
  assert.match(res.body.reply, /no envío/);
  res = await call("POST", `/api/jobs/${IDS[1]}/submitted`);
  assert.equal(res.body.lead.status, "submitted");
});
