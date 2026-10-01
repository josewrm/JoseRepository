import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RecordStore } from "../store/record-store.ts";
import {
  JarvisError,
  PROTOCOL_VERSION,
  TERMINAL_STATES,
  assertSdkValid,
  createReadHeaders,
  findForbiddenHostPrivateField,
  validateEventHashChain,
  validateEvidenceManifest,
  validateOperationHeaders,
  validateProtocolRecord,
  type ProtocolRecord,
} from "../protocol/jarvis.ts";

/**
 * Portable evidence export. Same layout as ../jarvis/docs/examples/evidence-packs/*:
 *   records/*.json, events/event-chain.json, evidence/evidence-manifest.json, headers/*.json
 * plus artifacts/*.json (host artifacts bound by content_hash). Host-private data
 * (auth token, job URL query, raw DB rows) never enters the pack.
 */

export interface ExportedPack {
  dir: string;
  manifest: ProtocolRecord;
  files: string[];
}

const REDACTED_AUTH = "HostAuth redacted";

const slug = (value: string) => value.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

export function buildEvidenceManifest(store: RecordStore, workSessionId: string, generatedByActorId: string): ProtocolRecord {
  const ws = store.getWorkSession(workSessionId);
  if (!ws) throw new JarvisError("unknown_state", "work_session_id", "Unknown WorkSession.");
  if (!TERMINAL_STATES.includes(ws.status)) {
    throw new JarvisError("invalid_evidence_export_state", "work_session.status", `Final export requires a terminal WorkSession; status is ${ws.status}.`);
  }
  const evidence = store.listRecords(workSessionId, "EvidenceItemRef");
  const host = store.getHostSession(workSessionId);
  const limitations = new Set<string>(host?.state?.limitations ?? []);
  for (const item of evidence) for (const ref of item.limitation_refs ?? []) if (ref !== "limitation:none-recorded") limitations.add(ref);
  const manifest: ProtocolRecord = {
    id: ws.evidence_manifest_ref ?? `evidence-manifest-${workSessionId}`,
    work_session_id: workSessionId,
    generated_by_actor_id: generatedByActorId,
    objective: ws.objective,
    event_chain_root: ws.last_event_hash,
    evidence_item_refs: evidence,
    policy_decision_refs: store.listRecords(workSessionId, "PolicyDecision").map((r) => r.id),
    request_refs: store.listRecords(workSessionId, "Request").map((r) => r.id),
    review_refs: store.listRecords(workSessionId, "Review").map((r) => r.id),
    takeover_refs: store.listRecords(workSessionId, "Takeover").map((r) => r.id),
    contribution_refs: store.listRecords(workSessionId, "Contribution").map((r) => r.id),
    export_profile: { profile: "portable_evidence_manifest", version: PROTOCOL_VERSION, redaction_profile_ref: "redaction:apply2interview-host-private" },
    generated_at: store.nowIso(),
    artifact_refs: [...new Set(evidence.map((item) => item.artifact_ref))],
    limitation_refs: limitations.size ? [...limitations] : ["limitation:none-recorded"],
    redaction_refs: ["redaction:apply2interview-host-private"],
  };
  assertSdkValid(validateEvidenceManifest(manifest, { workSession: ws }), "EvidenceManifest");
  const forbidden = findForbiddenHostPrivateField(manifest);
  if (forbidden) throw new JarvisError("forbidden_export_field", forbidden, "EvidenceManifest carries a host-private field.");
  return manifest;
}

function redactOperation(operation: ProtocolRecord): ProtocolRecord {
  return { ...operation, headers: { ...operation.headers, Authorization: REDACTED_AUTH } };
}

export function exportEvidencePack(store: RecordStore, workSessionId: string, outDir: string, generatedByActorId: string): ExportedPack {
  const ws = store.getWorkSession(workSessionId)!;
  const manifest = buildEvidenceManifest(store, workSessionId, generatedByActorId);
  const events = store.listEvents(workSessionId);
  assertSdkValid(validateEventHashChain(events), "event chain");
  if (events[events.length - 1].event_hash !== ws.last_event_hash) {
    throw new JarvisError("invalid_evidence_export_state", "event_chain_root", "Event chain does not end at WorkSession.last_event_hash.");
  }

  const dir = join(outDir, workSessionId);
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ["records", "events", "evidence", "headers", "artifacts"]) mkdirSync(join(dir, sub), { recursive: true });
  const files: string[] = [];
  const write = (path: string, value: unknown) => {
    const forbidden = findForbiddenHostPrivateField(value);
    if (forbidden && !path.startsWith("artifacts/")) throw new JarvisError("forbidden_export_field", forbidden, `${path} carries a host-private field.`);
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
    files.push(path);
  };

  // Participant and session records.
  const participants: [string, string, ProtocolRecord][] = [];
  for (const workerId of [ws.human_worker_id, ws.agent_worker_id]) {
    const worker = store.getRecord("Worker", workerId)!;
    participants.push(["Worker", `worker-${worker.type}`, worker]);
    const actor = store.listRecordsByType("Actor").find((a) => a.worker_id === workerId)!;
    participants.push(["Actor", `actor-${actor.type}`, actor]);
    const profileType = worker.type === "human" ? "HumanWorker" : "AgentWorker";
    const profile = store.listRecordsByType(profileType).find((p) => p.worker_id === workerId);
    if (profile) participants.push([profileType, worker.type === "human" ? "human-worker" : "agent-worker", profile]);
  }
  participants.push(["Policy", "policy", store.getRecord("Policy", ws.policy_id)!]);
  participants.push(["WorkSession", `work-session-${ws.status}`, ws]);
  for (const [objectType, name, record] of participants) {
    assertSdkValid(validateProtocolRecord(objectType, record), `${objectType} ${record.id ?? record.worker_id}`);
    write(`records/${name}.json`, { object_type: objectType, record });
  }

  for (const objectType of ["PolicyDecision", "Request", "Review", "Takeover", "Contribution", "LearningRecord", "MemoryProposal", "SkillProposal"]) {
    for (const record of store.listRecords(workSessionId, objectType)) {
      const envelope: ProtocolRecord = { object_type: objectType, record };
      if (objectType === "Review" && String(record.target_ref).startsWith("request:")) {
        // Validation context: the Request as it stood when the Review resolved it.
        const requestId = String(record.target_ref).slice("request:".length);
        envelope.context = { request: store.recordVersions("Request", requestId)[0] };
      }
      assertSdkValid(validateProtocolRecord(objectType, record, envelope.context ?? {}), `${objectType} ${record.id}`);
      write(`records/${slug(`${objectType}-${record.id}`).toLowerCase()}.json`, envelope);
    }
  }

  write("events/event-chain.json", { events });
  write("evidence/evidence-manifest.json", { evidence_manifest: manifest, work_session: ws });

  // OutcomeReports stay outside the sealed pack.
  const operations = [
    ...store.listParticipantOperations(),
    ...store.listOperations(workSessionId).filter((op) => op.operation_id !== "submitOutcomeReport"),
  ].map(redactOperation);
  operations.push({
    operation_id: "exportEvidenceManifest",
    method: "GET",
    path: `/work-sessions/${workSessionId}/export`,
    headers: { ...createReadHeaders({ authorization: REDACTED_AUTH, actorId: generatedByActorId }) },
    actor_id: generatedByActorId,
    work_session_id: workSessionId,
    expected_status: 200,
    body_ref: `EvidenceManifest:${manifest.id}`,
  });
  operations.forEach((operation, index) => {
    assertSdkValid(validateOperationHeaders(operation), `operation ${operation.operation_id}`);
    write(`headers/${String(index).padStart(2, "0")}-${slug(operation.operation_id).toLowerCase()}.json`, operation);
  });

  for (const artifact of store.listArtifacts(workSessionId)) {
    write(`artifacts/${slug(artifact.ref.replace(/^artifact:/, ""))}.json`, { ref: artifact.ref, kind: artifact.kind, content_hash: artifact.contentHash, content: artifact.content });
  }

  write("manifest.json", {
    pack_id: `apply2interview-${workSessionId}`,
    protocol_version: PROTOCOL_VERSION,
    title: "Apply2Interview WorkSession evidence pack",
    description: "Protocol records exported by the Apply2Interview host. Jarvis records protocol state; this host owns execution, storage, UI, and scoring.",
    host_shape_ref: "apply2interview_host",
    records: files.filter((f) => f.startsWith("records/")),
    evidence_manifests: ["evidence/evidence-manifest.json"],
    event_chains: ["events/event-chain.json"],
    operation_headers: files.filter((f) => f.startsWith("headers/")),
    artifacts: files.filter((f) => f.startsWith("artifacts/")),
    pack_limits: { certifies_implementation: false, claims_production_adoption: false, defines_host_execution: false },
  });
  return { dir, manifest, files };
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
