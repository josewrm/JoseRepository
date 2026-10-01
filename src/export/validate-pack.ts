import {
  validateEventHashChain,
  validateEvidenceManifest,
  validateOperationHeaders,
  validateProtocolRecord,
  type ProtocolRecord,
} from "../protocol/jarvis.ts";

/**
 * In-process pack validation with the same Jarvis SDK calls the Jarvis CLI
 * makes for `validate record`, `validate evidence-manifest`, `check hash-chain`
 * and `check headers`. Used where the CLI cannot run (the browser build).
 */

export interface PackCheck {
  command: string;
  file: string;
  ok: boolean;
  output: string;
}

export function validatePackFiles(files: Record<string, unknown>): PackCheck[] {
  const checks: PackCheck[] = [];
  const push = (command: string, file: string, result: { valid: boolean; errors: any[] }) =>
    checks.push({ command, file, ok: result.valid, output: result.valid ? "" : JSON.stringify(result.errors[0]) });
  for (const [file, value] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const v = value as ProtocolRecord;
    if (file.startsWith("records/")) push("validate record", file, validateProtocolRecord(v.object_type, v.record, v.context ?? {}));
    else if (file === "evidence/evidence-manifest.json") push("validate evidence-manifest", file, validateEvidenceManifest(v.evidence_manifest, { workSession: v.work_session }));
    else if (file === "events/event-chain.json") push("check hash-chain", file, validateEventHashChain(v.events));
    else if (file.startsWith("headers/")) push("check headers", file, validateOperationHeaders({ ...v, expected_status: v.expected_status ?? 200 }));
  }
  return checks;
}
