import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RecordStore } from "../store/record-store.ts";
import type { ProtocolRecord } from "../protocol/jarvis.ts";
import { buildEvidencePack } from "./evidence-pack.ts";

export { buildEvidenceManifest, buildEvidencePack } from "./evidence-pack.ts";

export interface ExportedPack {
  dir: string;
  manifest: ProtocolRecord;
  files: string[];
}

/** Writes the portable pack to <outDir>/<work_session_id>/. */
export function exportEvidencePack(store: RecordStore, workSessionId: string, outDir: string, generatedByActorId: string): ExportedPack {
  const pack = buildEvidencePack(store, workSessionId, generatedByActorId);
  const dir = join(outDir, workSessionId);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, value] of Object.entries(pack.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  }
  return { dir, manifest: pack.manifest, files: Object.keys(pack.files) };
}

export function exportOutcomeReports(store: RecordStore, workSessionId: string, outDir: string): string[] {
  const reports = store.listRecords(workSessionId, "OutcomeReport");
  if (!reports.length) return [];
  const dir = join(outDir, workSessionId);
  mkdirSync(dir, { recursive: true });
  const ws = store.getWorkSession(workSessionId)!;
  return reports.map((report) => {
    const path = join(dir, `${report.id}.json`);
    writeFileSync(path, `${JSON.stringify({ object_type: "OutcomeReport", record: report, context: { workSession: ws } }, null, 2)}\n`);
    return path;
  });
}
