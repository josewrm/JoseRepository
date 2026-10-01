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
import { HostStore } from "../store/host-store.ts";
import { Assistant } from "../app/assistant.ts";
import { DETAIL_URL, parseJobCards } from "../../vendor/ai-job-search/linkedin-search/helpers.ts";
import exampleSearchHtml from "../../test/fixtures/linkedin/search.html";
import exampleDetail1 from "../../test/fixtures/linkedin/detail-4100000001.html";
import exampleDetail2 from "../../test/fixtures/linkedin/detail-4100000002.html";
import exampleDetail3 from "../../test/fixtures/linkedin/detail-4100000003.html";
import exampleDetail4 from "../../test/fixtures/linkedin/detail-4100000004.html";
// Bundled as text by the build (esbuild text loader).
import exampleJdHtml from "../../test/fixtures/ejemplo/oferta-ewm.html";
import cvGeneral from "../../test/fixtures/ejemplo/cv-general-es.md";
import cvEwm from "../../test/fixtures/ejemplo/cv-ewm-es.md";
import cvEnglish from "../../test/fixtures/ejemplo/cv-english.md";

/** Private build only: the candidate's own profile, injected at build time (see scripts/build-artifact.ts). */
const SEED = (window as any).A2I_SEED as { profile: { source_cvs: { label: string; text: string }[]; candidate_facts: Record<string, unknown>; search?: Record<string, unknown> } } | undefined;
const STORAGE_KEY = SEED ? "jarvis.private.records.v1" : "apply2interview.records.v2";
const AUTH = "HostAuth browser-local";
const EXAMPLE_URL = "https://empleo.example.test/logistica-norte/desarrollador-sap-ewm";
const EXAMPLE_SOURCES = [
  { label: "General", text: cvGeneral },
  { label: "EWM", text: cvEwm },
  { label: "English", text: cvEnglish },
];
const EXAMPLE_FACTS = {
  name: "Lucía Ejemplo",
  email: "lucia.ejemplo@example.test",
  phone: "+34 600 000 000",
  location: "Valencia, España",
  visa: "Ciudadana UE",
  languages: ["Español", "Inglés"],
  availability: "Un mes",
  willing_to_relocate: true,
};

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

/** Fictional example postings, shaped like LinkedIn's public guest pages. */
const EXAMPLE_DETAILS: Record<string, string> = {
  [`${DETAIL_URL}/4100000001`]: exampleDetail1,
  [`${DETAIL_URL}/4100000002`]: exampleDetail2,
  [`${DETAIL_URL}/4100000003`]: exampleDetail3,
  [`${DETAIL_URL}/4100000004`]: exampleDetail4,
};
const EXAMPLE_LEADS = parseJobCards(exampleSearchHtml);

/** The example job pages are bundled; any other link needs a server this edition does not have. */
const fetchImpl = (async (input: string | URL | Request) => {
  const url = String(input);
  const page = url === EXAMPLE_URL ? exampleJdHtml : EXAMPLE_DETAILS[url];
  if (page) {
    const response = new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    Object.defineProperty(response, "url", { value: url });
    return response;
  }
  throw new Error("la edición navegador no puede leer páginas de empleo (no hay servidor). Pega el texto de la oferta para continuar");
}) as typeof fetch;

const store = new RecordStore(db, { authorize: (auth) => auth === AUTH });
const service = new Apply2InterviewService(store, { authorization: AUTH, fetchImpl });
const assistant = new Assistant(new HostStore(db), service, { fetchImpl, exampleLeads: SEED ? [] : EXAMPLE_LEADS });

const deps: RouteDeps = {
  service,
  assistant,
  exportPack: (wsId) => {
    const pack = buildEvidencePack(store, wsId, HUMAN_ACTOR_ID);
    return { location: "this browser", files: pack.files, manifest: pack.manifest, checks: validatePackFiles(pack.files), validator: "Jarvis SDK validators" };
  },
};

async function seed(): Promise<void> {
  service.ensureParticipants();
  if (SEED) {
    // Private edition: your profile, no example jobs or example application.
    if (!assistant.profile().sources.length) {
      assistant.saveProfile(SEED.profile);
      save();
    }
    return;
  }
  if (!assistant.profile().sources.length) {
    // Example profile and example jobs so the assistant opens with something to show.
    assistant.saveProfile({ source_cvs: EXAMPLE_SOURCES, candidate_facts: EXAMPLE_FACTS, search: { query: "SAP EWM", location: "España" } });
    await assistant.search({});
    save();
  }
  if (store.listWorkSessions().length) return;
  // First visit: one example WorkSession so the page opens in a working state.
  await service.startSession({ job_url: EXAMPLE_URL, source_cvs: EXAMPLE_SOURCES, candidate_facts: EXAMPLE_FACTS });
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
  privateEdition: Boolean(SEED),
  exampleUrl: EXAMPLE_URL,
  exampleSources: EXAMPLE_SOURCES,
  exampleFacts: EXAMPLE_FACTS,
  reset: () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};
