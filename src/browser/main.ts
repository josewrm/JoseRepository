// Browser edition of the Apply2Interview host. Same store, Policy, agent loop,
// scoring and export code as the Node server; storage is an in-memory database
// saved to this browser's localStorage, and the UI's /api calls are answered
// in-page instead of over HTTP.
import { MemoryDatabase } from "../store/memory-db.ts";
import { RecordStore } from "../store/record-store.ts";
import { Apply2InterviewService } from "../app/service.ts";
import { HUMAN_ACTOR_ID } from "../app/participants.ts";
import { buildEvidencePack } from "../export/evidence-pack.ts";
import { validatePackFiles } from "../export/validate-pack.ts";
import { handleApi, type RouteDeps } from "../server/routes.ts";
// Bundled as text by the build (esbuild text loader).
import exampleJdHtml from "../../test/fixtures/jd-public.html";
import exampleCv from "../../test/fixtures/fake-cv.md";

const STORAGE_KEY = "apply2interview.records.v1";
const AUTH = "HostAuth browser-local";
const EXAMPLE_URL = "https://jobs.example.test/northwind/senior-backend-engineer";
const EXAMPLE_FACTS = { name: "Alex Example", location: "Valencia, Spain", visa: "EU citizen", languages: ["Spanish", "English"] };

function load(): MemoryDatabase {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return new MemoryDatabase(saved);
  } catch {
    // Storage unavailable (private window, preview): run in memory only.
  }
  return new MemoryDatabase();
}

const db = load();
const save = () => {
  try {
    localStorage.setItem(STORAGE_KEY, db.serialize());
  } catch {
    // Not persisted; the session still works until the page closes.
  }
};

/** The example job page is bundled; any other link needs a server this edition does not have. */
const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === EXAMPLE_URL) {
    const response = new Response(exampleJdHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }
  throw new Error("the browser edition cannot read job pages directly (no server). Paste the job description text to continue");
}) as typeof fetch;

const store = new RecordStore(db, { authorize: (auth) => auth === AUTH });
const service = new Apply2InterviewService(store, { authorization: AUTH, fetchImpl });

const deps: RouteDeps = {
  service,
  exportPack: (wsId) => {
    const pack = buildEvidencePack(store, wsId, HUMAN_ACTOR_ID);
    return { location: "this browser", files: pack.files, manifest: pack.manifest, checks: validatePackFiles(pack.files), validator: "Jarvis SDK validators" };
  },
};

async function seed(): Promise<void> {
  service.ensureParticipants();
  if (store.listWorkSessions().length) return;
  // First visit: one example WorkSession so the page opens in a working state.
  await service.startSession({ job_url: EXAMPLE_URL, master_cv: exampleCv, candidate_facts: EXAMPLE_FACTS });
  save();
}

const ready = seed();
const nativeFetch = window.fetch.bind(window);

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, "https://local.invalid");
  if (!url.pathname.startsWith("/api/")) return nativeFetch(input as RequestInfo, init);
  await ready;
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const result = await handleApi(deps, { method, pathname: url.pathname, headers: {}, body });
  if (method !== "GET") save();
  const headers: Record<string, string> = { "content-type": result.text !== undefined ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8" };
  if (result.filename) headers["content-disposition"] = `attachment; filename="${result.filename}"`;
  return new Response(result.text ?? JSON.stringify(result.body, null, 2), { status: result.status, headers });
}) as typeof fetch;

(window as any).A2I_BROWSER = {
  exampleUrl: EXAMPLE_URL,
  exampleCv,
  exampleFacts: EXAMPLE_FACTS,
  reset: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};
