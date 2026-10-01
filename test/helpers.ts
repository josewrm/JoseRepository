import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/store/db.ts";
import { RecordStore } from "../src/store/record-store.ts";
import { Apply2InterviewService } from "../src/app/service.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");
export const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

export const AUTH = "HostAuth test-token";

/** fetch stand-in: serves fixture pages by URL, so tests never touch the network. */
export function fakeFetch(pages: Record<string, { status?: number; body: string; url?: string; type?: string }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const page = pages[url];
    if (!page) throw new Error(`network unreachable: ${url}`);
    const response = new Response(page.body, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html; charset=utf-8" } });
    Object.defineProperty(response, "url", { value: page.url ?? url });
    return response;
  }) as typeof fetch;
}

export function makeService(pages: Parameters<typeof fakeFetch>[0], clock?: () => Date) {
  const db = openDatabase(":memory:");
  const store = new RecordStore(db, { clock, authorize: (auth) => auth === AUTH });
  const service = new Apply2InterviewService(store, { authorization: AUTH, fetchImpl: fakeFetch(pages) });
  return { db, store, service };
}

export const JOB_URL = "https://jobs.example.test/northwind/senior-backend";
export const LOGIN_URL = "https://jobs.example.test/walled/123";

export const FACTS = { name: "Alex Example", location: "Valencia, Spain", visa: "EU citizen", languages: ["Spanish", "English"] };
