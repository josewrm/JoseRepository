import { test } from "node:test";
import assert from "node:assert/strict";
import { makeService, fixture, JOB_URL, FACTS } from "./helpers.ts";
import { MemoryDatabase } from "../src/store/memory-db.ts";
import { buildEvidencePack } from "../src/export/evidence-pack.ts";
import { validatePackFiles } from "../src/export/validate-pack.ts";
import { HUMAN_ACTOR_ID } from "../src/app/participants.ts";

const pages = { [JOB_URL]: { body: fixture("jd-public.html") } };

test("browser storage: the full loop runs on MemoryDatabase and the pack passes the Jarvis SDK checks", async () => {
  const { service, store, db } = makeService(pages, undefined, "memory");
  const wsId = await service.startSession({ job_url: JOB_URL, master_cv: fixture("fake-cv.md"), candidate_facts: FACTS });
  for (const r of service.view(wsId).requests) await service.review(wsId, r.id, { decision: "approve" });
  service.complete(wsId);
  for (const r of service.view(wsId).requests.filter((x: any) => x.status === "pending")) await service.review(wsId, r.id, { decision: "approve" });
  service.complete(wsId);
  assert.equal(store.getWorkSession(wsId)!.status, "completed");

  const pack = buildEvidencePack(store, wsId, HUMAN_ACTOR_ID);
  const checks = validatePackFiles(pack.files);
  assert.ok(checks.length > 40);
  assert.deepEqual(checks.filter((c) => !c.ok), []);

  // Serialize and reload: the same WorkSession comes back.
  const reloaded = new MemoryDatabase((db as MemoryDatabase).serialize());
  assert.equal(reloaded.prepare("SELECT json FROM records WHERE object_type = ? AND id = ?").get("WorkSession", wsId) !== undefined, true);
});

test("MemoryDatabase rolls back a failed transaction and rejects unknown SQL", () => {
  const db = new MemoryDatabase();
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO operations (work_session_id, operation_id, json) VALUES (?, ?, ?)").run("ws", "op", "{}");
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT json FROM operations WHERE work_session_id = ? ORDER BY seq").all("ws").length, 0);
  assert.throws(() => db.prepare("DELETE FROM events"), /unsupported statement/);
});
