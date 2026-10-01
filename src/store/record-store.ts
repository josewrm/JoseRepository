import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "./db.ts";
import {
  GENESIS_HASH,
  JarvisError,
  PROTOCOL_VERSION,
  REQUEST_TRANSITIONS,
  REVIEW_TO_REQUEST_STATUS,
  TAKEOVER_TRANSITIONS,
  TERMINAL_STATES,
  TRANSITION_EVENT,
  WORK_SESSION_TRANSITIONS,
  assertSdkValid,
  contentHash,
  createJarvisEvent,
  createOperationPath,
  getOperationBinding,
  validateMutationHeaders,
  validateProtocolRecord,
  type JarvisHeaders,
  type ObjectType,
  type ProtocolRecord,
  type WorkSessionStatus,
} from "../protocol/jarvis.ts";

/**
 * Protocol record store.
 *
 * Host-owned implementation of the Jarvis v0.1 mutation rules:
 * headers, idempotency, revision, previous event hash, actor authority,
 * PolicyDecision-before-agent-action, takeover lock epochs, append-only
 * hash-chained JarvisEvents.
 */

export interface StoreOptions {
  clock?: () => Date;
  /** Host auth check for the Authorization header. Host owns auth. */
  authorize?: (authorization: string) => boolean;
  maxPastSkewMs?: number;
}

export interface MutationResult {
  event: ProtocolRecord | null;
  records: ProtocolRecord[];
  workSession: ProtocolRecord | null;
  replayed: boolean;
}

/** Binding of an AgentWorker mutation to the PolicyDecision recorded before it. */
export interface AgentActionBinding {
  policyDecisionId: string;
  action: string;
  /** Lock epoch the agent observed when it started this action. */
  lockEpoch?: number;
  /** "blocked_scope": the mutation records a blocked scope (Request, waiting_on_human) from a deny/review_required decision. */
  purpose?: "blocked_scope";
}

interface Write {
  objectType: ObjectType | "EvidenceItemRef";
  record: ProtocolRecord;
  /** Extra validation context for SDK validators (e.g. the Request a Review resolves). */
  context?: Record<string, unknown>;
}

interface BuildContext {
  eventId: string;
  sequence: number;
  now: string;
  workSession: ProtocolRecord;
}

interface BuildResult {
  payload: ProtocolRecord;
  writes?: Write[];
  statusTo?: WorkSessionStatus;
  workSessionPatch?: ProtocolRecord;
  afterCommit?: () => void;
}

interface WsMutationSpec {
  operationId: string;
  headers: JarvisHeaders;
  workSessionId: string;
  bodyActorId: string;
  body: unknown;
  bodyRef: string;
  eventType: string;
  agent?: AgentActionBinding;
  /** True when the agent mutation is a Request created from a deny/review_required decision. */
  agentCreatesRequest?: boolean;
  allowAfterTerminal?: boolean;
  build: (ctx: BuildContext) => BuildResult;
}

const NON_TERMINAL_ALLOWED_AFTER_COMPLETION = new Set([
  "createLearningRecord",
  "createMemoryProposal",
  "createSkillProposal",
]);

export class RecordStore {
  db: DatabaseSync;
  clock: () => Date;
  authorize: (authorization: string) => boolean;
  maxPastSkewMs: number;

  constructor(db: DatabaseSync, options: StoreOptions = {}) {
    this.db = db;
    this.clock = options.clock ?? (() => new Date());
    this.authorize = options.authorize ?? (() => true);
    this.maxPastSkewMs = options.maxPastSkewMs ?? 300_000;
  }

  nowIso(): string {
    return this.clock().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // ---------------------------------------------------------------- reads

  getRecord(objectType: string, id: string): ProtocolRecord | null {
    const row = this.db
      .prepare("SELECT json FROM records WHERE object_type = ? AND id = ?")
      .get(objectType, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  requireRecord(objectType: string, id: string, field: string): ProtocolRecord {
    const record = this.getRecord(objectType, id);
    if (!record) throw new JarvisError("unknown_state", field, `${objectType} ${id} does not exist.`);
    return record;
  }

  listRecords(workSessionId: string, objectType: string): ProtocolRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM records WHERE work_session_id = ? AND object_type = ? ORDER BY rowid")
      .all(workSessionId, objectType) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }

  listRecordsByType(objectType: string): ProtocolRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM records WHERE object_type = ? ORDER BY rowid")
      .all(objectType) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }

  recordVersions(objectType: string, id: string): ProtocolRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM record_versions WHERE object_type = ? AND id = ? ORDER BY version")
      .all(objectType, id) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }

  getWorkSession(id: string): ProtocolRecord | null {
    return this.getRecord("WorkSession", id);
  }

  listWorkSessions(): ProtocolRecord[] {
    return this.listRecordsByType("WorkSession").reverse();
  }

  listEvents(workSessionId: string): ProtocolRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM events WHERE work_session_id = ? ORDER BY sequence")
      .all(workSessionId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }

  getEvent(eventId: string): ProtocolRecord | null {
    const row = this.db.prepare("SELECT json FROM events WHERE id = ?").get(eventId) as
      | { json: string }
      | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  findEventFor(workSessionId: string, type: string, objectId: string): ProtocolRecord | null {
    return (
      this.listEvents(workSessionId).find(
        (event) => event.type === type && event.payload?.object_id === objectId,
      ) ?? null
    );
  }

  listOperations(workSessionId: string): ProtocolRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM operations WHERE work_session_id = ? ORDER BY seq")
      .all(workSessionId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }

  /** Non-WorkSession operations (Worker/Actor registration) for export packs. */
  listParticipantOperations(): ProtocolRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM operations WHERE work_session_id IS NULL AND operation_id IN ('registerWorker', 'registerActor') ORDER BY seq")
      .all() as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }

  lockEpoch(workSessionId: string): number {
    const row = this.db
      .prepare("SELECT lock_epoch FROM host_sessions WHERE work_session_id = ?")
      .get(workSessionId) as { lock_epoch: number } | undefined;
    return row?.lock_epoch ?? 0;
  }

  // ----------------------------------------------------- shared validation

  private checkHeaders(headers: JarvisHeaders, workSessionScoped: boolean): void {
    assertSdkValid(
      validateMutationHeaders(headers, {
        workSessionScoped,
        now: this.clock(),
        maxPastSkewMs: this.maxPastSkewMs,
      }),
      "headers",
    );
    if (!this.authorize(String(headers.Authorization))) {
      throw new JarvisError("unauthorized_actor", "headers.Authorization", "Host authentication failed.");
    }
  }

  private idempotencyReplay(
    headers: JarvisHeaders,
    operationId: string,
    payloadHash: string,
  ): MutationResult | null {
    const key = String(headers["Jarvis-Idempotency-Key"]);
    const row = this.db.prepare("SELECT * FROM idempotency WHERE idempotency_key = ?").get(key) as
      | Record<string, string>
      | undefined;
    if (!row) return null;
    if (
      row.actor_id !== headers["Jarvis-Actor-Id"] ||
      row.protocol_version !== headers["Jarvis-Protocol-Version"] ||
      row.operation_id !== operationId ||
      row.payload_hash !== payloadHash
    ) {
      throw new JarvisError(
        "duplicate_idempotency_key_mismatch",
        "headers.Jarvis-Idempotency-Key",
        "Idempotency key was already used with a different actor, version, operation, or payload.",
      );
    }
    return { ...JSON.parse(row.result_json), replayed: true };
  }

  private requireActor(actorId: string): ProtocolRecord {
    const actor = this.getRecord("Actor", actorId);
    if (!actor) throw new JarvisError("unauthorized_actor", "headers.Jarvis-Actor-Id", `Unknown Actor ${actorId}.`);
    const now = this.clock().getTime();
    if (actor.valid_until && Date.parse(actor.valid_until) < now) {
      throw new JarvisError("unauthorized_actor", "headers.Jarvis-Actor-Id", "Actor authority expired.");
    }
    return actor;
  }

  private checkActorAuthority(actor: ProtocolRecord, eventType: string): void {
    const authority = actor.event_authority ?? {};
    const allowed: string[] = authority.allowed_event_types ?? [];
    if (!authority.can_append_events || !allowed.includes(eventType)) {
      throw new JarvisError(
        "unauthorized_actor",
        "headers.Jarvis-Actor-Id",
        `Actor ${actor.id} has no authority for ${eventType}.`,
      );
    }
  }

  private checkBodyActor(headers: JarvisHeaders, bodyActorId: string): string {
    const actorId = String(headers["Jarvis-Actor-Id"]);
    if (bodyActorId !== actorId) {
      throw new JarvisError(
        "actor_body_id_mismatch",
        "headers.Jarvis-Actor-Id",
        "Jarvis-Actor-Id MUST match the actor field in the mutation body.",
      );
    }
    return actorId;
  }

  private validateWrite(write: Write): void {
    if (write.objectType === "EvidenceItemRef") {
      assertSdkValid(validateProtocolRecord("EvidenceItemRef", write.record), "EvidenceItemRef");
      return;
    }
    assertSdkValid(validateProtocolRecord(write.objectType, write.record, write.context ?? {}), write.objectType);
  }

  private persistRecord(write: Write, eventId: string | null, now: string): void {
    const { objectType, record } = write;
    // HumanWorker and AgentWorker profiles are keyed by their worker_id.
    const key: string = record.id ?? record.worker_id;
    const existing = this.db
      .prepare("SELECT version FROM records WHERE object_type = ? AND id = ?")
      .get(objectType, key) as { version: number } | undefined;
    const version = (existing?.version ?? 0) + 1;
    const json = JSON.stringify(record);
    const workSessionId = objectType === "WorkSession" ? record.id : (record.work_session_id ?? null);
    this.db
      .prepare(
        `INSERT INTO records (object_type, id, work_session_id, version, json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (object_type, id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(objectType, key, workSessionId, version, json, now);
    this.db
      .prepare("INSERT INTO record_versions (object_type, id, version, event_id, json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(objectType, key, version, eventId, json, now);
  }

  private persistOperation(workSessionId: string | null, operation: ProtocolRecord): void {
    this.db
      .prepare("INSERT INTO operations (work_session_id, operation_id, json) VALUES (?, ?, ?)")
      .run(workSessionId, operation.operation_id, JSON.stringify(operation));
  }

  private persistIdempotency(headers: JarvisHeaders, operationId: string, payloadHash: string, result: MutationResult): void {
    this.db
      .prepare(
        `INSERT INTO idempotency (idempotency_key, actor_id, protocol_version, operation_id, payload_hash, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(headers["Jarvis-Idempotency-Key"]),
        String(headers["Jarvis-Actor-Id"]),
        String(headers["Jarvis-Protocol-Version"]),
        operationId,
        payloadHash,
        JSON.stringify({ ...result, replayed: false }),
        this.nowIso(),
      );
  }

  private operationEnvelope(
    operationId: string,
    headers: JarvisHeaders,
    pathParams: Record<string, string>,
    extra: ProtocolRecord,
  ): ProtocolRecord {
    const binding = getOperationBinding(operationId);
    return {
      operation_id: operationId,
      method: binding.method,
      path: createOperationPath(operationId, pathParams),
      headers: { ...headers },
      actor_id: headers["Jarvis-Actor-Id"],
      expected_status: binding.statuses.find((status: number) => status < 400),
      ...extra,
    };
  }

  // ------------------------------------------- non-WorkSession mutations

  private nonWsMutation(
    operationId: string | null,
    headers: JarvisHeaders,
    bodyActorId: string | null,
    body: unknown,
    writes: Write[],
    envelope: { pathParams: Record<string, string>; bodyRef: string } | null,
    check: () => void = () => {},
  ): MutationResult {
    this.checkHeaders(headers, false);
    const opKey = operationId ?? "hostRegisterPolicy";
    const payloadHash = contentHash({ operationId: opKey, body });
    const replay = this.idempotencyReplay(headers, opKey, payloadHash);
    if (replay) return replay;
    if (bodyActorId !== null) this.checkBodyActor(headers, bodyActorId);
    check();
    for (const write of writes) this.validateWrite(write);
    const now = this.nowIso();
    const result: MutationResult = { event: null, records: writes.map((w) => w.record), workSession: null, replayed: false };
    transaction(this.db, () => {
      for (const write of writes) this.persistRecord(write, null, now);
      if (operationId && envelope) {
        const workSessionId = writes.find((w) => w.record.work_session_id)?.record.work_session_id ?? null;
        this.persistOperation(
          workSessionId,
          this.operationEnvelope(operationId, headers, envelope.pathParams, { body_ref: envelope.bodyRef }),
        );
      }
      this.persistIdempotency(headers, opKey, payloadHash, result);
    });
    return result;
  }

  /** registerWorker. Registration does not create accounts or credentials; host auth gates it. */
  registerWorker(headers: JarvisHeaders, worker: ProtocolRecord): MutationResult {
    return this.nonWsMutation("registerWorker", headers, null, { worker }, [{ objectType: "Worker", record: worker }], {
      pathParams: { worker_id: worker.id },
      bodyRef: `Worker:${worker.id}`,
    });
  }

  registerActor(
    headers: JarvisHeaders,
    actor: ProtocolRecord,
    profile?: { objectType: "HumanWorker" | "AgentWorker"; record: ProtocolRecord },
  ): MutationResult {
    const writes: Write[] = [{ objectType: "Actor", record: actor }];
    if (profile) writes.push({ objectType: profile.objectType, record: profile.record });
    return this.nonWsMutation("registerActor", headers, null, { actor, profile }, writes, {
      pathParams: { actor_id: actor.id },
      bodyRef: `Actor:${actor.id}`,
    }, () => {
      this.requireRecord("Worker", actor.worker_id, "actor.worker_id");
      if (profile && (profile.record.worker_id !== actor.worker_id || profile.record.actor_id !== actor.id)) {
        throw new JarvisError("invalid_export", `${profile.objectType}.actor_id`, "Profile MUST bind the registered Worker and Actor.");
      }
    });
  }

  /** Host operation: the HumanWorker registers the Policy they own. */
  registerPolicy(headers: JarvisHeaders, policy: ProtocolRecord): MutationResult {
    return this.nonWsMutation(null, headers, policy.created_by_actor_id, { policy }, [{ objectType: "Policy", record: policy }], null, () => {
      const actor = this.requireActor(policy.created_by_actor_id);
      if (actor.type !== "human" || actor.worker_id !== policy.owner_worker_id) {
        throw new JarvisError("unauthorized_actor", "Policy.created_by_actor_id", "Policy is owned and created by its HumanWorker.");
      }
    });
  }

  submitOutcomeReport(headers: JarvisHeaders, report: ProtocolRecord): MutationResult {
    const workSession = this.requireRecord("WorkSession", report.work_session_id, "OutcomeReport.work_session_id");
    return this.nonWsMutation(
      "submitOutcomeReport",
      headers,
      report.accepted_by_actor_id,
      { report },
      [{ objectType: "OutcomeReport", record: report, context: { workSession } }],
      { pathParams: {}, bodyRef: `OutcomeReport:${report.id}` },
      () => {
        const actor = this.requireActor(report.accepted_by_actor_id);
        const human = this.getRecord("Worker", actor.worker_id);
        if (actor.type !== "human" || human?.id !== workSession.human_worker_id) {
          throw new JarvisError("unauthorized_actor", "accepted_by_actor_id", "Only the WorkSession HumanWorker accepts OutcomeReports.");
        }
        for (const ref of report.learning_record_refs ?? []) {
          const learning = this.getRecord("LearningRecord", ref);
          if (!learning || learning.work_session_id !== report.work_session_id) {
            throw new JarvisError("outcome_report_without_learning_record", "learning_record_refs", `LearningRecord ${ref} is not part of this WorkSession.`);
          }
        }
      },
    );
  }

  // ----------------------------------------------- WorkSession creation

  createWorkSession(headers: JarvisHeaders, input: ProtocolRecord): MutationResult {
    this.checkHeaders(headers, true);
    const payloadHash = contentHash({ operationId: "createWorkSession", input });
    const replay = this.idempotencyReplay(headers, "createWorkSession", payloadHash);
    if (replay) return replay;
    if (headers["Jarvis-Expected-WorkSession-Revision"] !== 0) {
      throw new JarvisError("stale_work_session_revision", "headers.Jarvis-Expected-WorkSession-Revision", "WorkSession creation uses expected revision 0.");
    }
    if (headers["Jarvis-Previous-Event-Hash"] !== GENESIS_HASH) {
      throw new JarvisError("invalid_previous_event_hash", "headers.Jarvis-Previous-Event-Hash", "WorkSession creation links to the protocol genesis hash.");
    }
    const actorId = this.checkBodyActor(headers, input.created_by_actor_id);
    const actor = this.requireActor(actorId);
    this.checkActorAuthority(actor, "work_session.created");
    if (!input.objective) throw new JarvisError("missing_objective", "objective", "WorkSession requires an objective.");
    const policy = this.getRecord("Policy", input.policy_id);
    if (!policy) throw new JarvisError("missing_policy", "policy_id", "WorkSession requires an attached Policy.");
    const human = this.requireRecord("Worker", input.human_worker_id, "human_worker_id");
    const agent = this.requireRecord("Worker", input.agent_worker_id, "agent_worker_id");
    if (human.type !== "human" || agent.type !== "agent" || actor.worker_id !== human.id) {
      throw new JarvisError("unauthorized_actor", "created_by_actor_id", "The HumanWorker's Actor creates the WorkSession.");
    }
    if (this.getRecord("WorkSession", input.id)) {
      throw new JarvisError("invalid_transition", "id", "WorkSession already exists.");
    }
    const now = this.nowIso();
    const eventId = `evt-${input.id}-1`;
    const event = createJarvisEvent({
      id: eventId,
      sequence: 1,
      type: "work_session.created",
      workSessionId: input.id,
      actorId,
      timestamp: now,
      payload: {
        object_type: "work_session",
        object_id: input.id,
        action: "created",
        summary: "WorkSession created with HumanWorker, AgentWorker, objective, and Policy.",
      },
      previousHash: GENESIS_HASH,
    });
    const workSession = {
      id: input.id,
      protocol_version: PROTOCOL_VERSION,
      created_by_actor_id: actorId,
      objective: input.objective,
      human_worker_id: input.human_worker_id,
      agent_worker_id: input.agent_worker_id,
      policy_id: input.policy_id,
      status: "active",
      revision: 1,
      last_event_hash: event.event_hash,
      event_log_ref: `event-log:${input.id}`,
      created_at: now,
      updated_at: now,
      ...(input.source_ref ? { source_ref: input.source_ref } : {}),
      contribution_ledger_ref: `ledger:${input.id}`,
    };
    this.validateWrite({ objectType: "WorkSession", record: workSession });
    const result: MutationResult = { event, records: [workSession], workSession, replayed: false };
    transaction(this.db, () => {
      this.insertEvent(event);
      this.persistRecord({ objectType: "WorkSession", record: workSession }, eventId, now);
      this.persistOperation(
        input.id,
        this.operationEnvelope("createWorkSession", headers, {}, {
          work_session_id: input.id,
          body_ref: `WorkSession:${input.id}`,
          expected_event_ref: eventId,
        }),
      );
      this.persistIdempotency(headers, "createWorkSession", payloadHash, result);
    });
    return result;
  }

  private insertEvent(event: ProtocolRecord): void {
    this.db
      .prepare(
        "INSERT INTO events (work_session_id, sequence, id, type, actor_id, event_hash, previous_hash, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.work_session_id,
        event.sequence,
        event.id,
        event.type,
        event.actor_id,
        event.event_hash,
        event.previous_hash,
        JSON.stringify(event),
      );
  }

  // ------------------------------------------ WorkSession-scoped mutation core

  private wsMutation(spec: WsMutationSpec): MutationResult {
    const { headers } = spec;
    this.checkHeaders(headers, true);
    const payloadHash = contentHash({ operationId: spec.operationId, workSessionId: spec.workSessionId, body: spec.body });
    const replay = this.idempotencyReplay(headers, spec.operationId, payloadHash);
    if (replay) return replay;

    const workSession = this.requireRecord("WorkSession", spec.workSessionId, "work_session_id");
    if (workSession.status === "closed") {
      throw new JarvisError("mutation_after_closed", "work_session.status", "Closed WorkSessions are sealed.");
    }
    if (TERMINAL_STATES.includes(workSession.status) && !spec.allowAfterTerminal && !NON_TERMINAL_ALLOWED_AFTER_COMPLETION.has(spec.operationId)) {
      throw new JarvisError("sealed_work_session_mutation", "work_session.status", `WorkSession is ${workSession.status}; new work is rejected.`);
    }
    if (headers["Jarvis-Expected-WorkSession-Revision"] !== workSession.revision) {
      throw new JarvisError("stale_work_session_revision", "headers.Jarvis-Expected-WorkSession-Revision", `Expected revision ${headers["Jarvis-Expected-WorkSession-Revision"]} but WorkSession is at ${workSession.revision}.`);
    }
    if (headers["Jarvis-Previous-Event-Hash"] !== workSession.last_event_hash) {
      throw new JarvisError("invalid_previous_event_hash", "headers.Jarvis-Previous-Event-Hash", "Previous event hash does not match WorkSession.last_event_hash.");
    }

    const actorId = this.checkBodyActor(headers, spec.bodyActorId);
    const actor = this.requireActor(actorId);
    if (![workSession.human_worker_id, workSession.agent_worker_id].includes(actor.worker_id)) {
      throw new JarvisError("unauthorized_actor", "headers.Jarvis-Actor-Id", "Actor is not a participant of this WorkSession.");
    }
    this.checkActorAuthority(actor, spec.eventType);
    if (actor.type === "agent" && spec.operationId !== "recordPolicyDecision") {
      this.checkAgentBinding(workSession, actorId, spec);
    }

    const sequence = workSession.revision + 1;
    const now = this.nowIso();
    const eventId = `evt-${workSession.id}-${sequence}`;
    const built = spec.build({ eventId, sequence, now, workSession });
    const writes = built.writes ?? [];

    let nextStatus: WorkSessionStatus = workSession.status;
    if (built.statusTo && built.statusTo !== workSession.status) {
      this.checkTransition(workSession, built.statusTo, built.payload);
      nextStatus = built.statusTo;
    }

    const event = createJarvisEvent({
      id: eventId,
      sequence,
      type: spec.eventType,
      workSessionId: workSession.id,
      actorId,
      timestamp: now,
      payload: built.payload,
      previousHash: workSession.last_event_hash,
    });
    const nextWorkSession = {
      ...workSession,
      ...(built.workSessionPatch ?? {}),
      status: nextStatus,
      revision: workSession.revision + 1,
      last_event_hash: event.event_hash,
      updated_at: now,
    };
    for (const write of writes) this.validateWrite(write);
    this.validateWrite({ objectType: "WorkSession", record: nextWorkSession });

    const result: MutationResult = {
      event,
      records: writes.map((w) => w.record),
      workSession: nextWorkSession,
      replayed: false,
    };
    transaction(this.db, () => {
      this.insertEvent(event);
      for (const write of writes) this.persistRecord(write, eventId, now);
      this.persistRecord({ objectType: "WorkSession", record: nextWorkSession }, eventId, now);
      this.persistOperation(
        workSession.id,
        this.operationEnvelope(spec.operationId, headers, { work_session_id: workSession.id }, {
          work_session_id: workSession.id,
          body_ref: spec.bodyRef,
          expected_event_ref: eventId,
        }),
      );
      this.persistIdempotency(headers, spec.operationId, payloadHash, result);
      built.afterCommit?.();
    });
    return result;
  }

  private checkTransition(workSession: ProtocolRecord, to: WorkSessionStatus, payload: ProtocolRecord): void {
    const from = workSession.status as WorkSessionStatus;
    if (!WORK_SESSION_TRANSITIONS[from]?.includes(to)) {
      throw new JarvisError("invalid_transition", "status", `WorkSession transition ${from} -> ${to} is not allowed.`);
    }
    const unresolved = this.listRecords(workSession.id, "Request").filter((request) =>
      ["pending", "acknowledged"].includes(request.status),
    );
    if (from === "waiting_on_human" && to !== "takeover") {
      if (unresolved.length > 0 || !(payload.field_refs ?? []).length) {
        throw new JarvisError(
          "missing_blocked_scope_resolution_refs",
          "payload.field_refs",
          "Leaving waiting_on_human requires every blocked scope resolved and referenced.",
        );
      }
    }
    if (from === "reconciling" && !(payload.field_refs ?? []).some((ref: string) => ref.startsWith("takeover:"))) {
      throw new JarvisError("missing_reconciliation_refs", "payload.field_refs", "Leaving reconciling requires reconciliation refs.");
    }
    if (to === "completed" && unresolved.length > 0) {
      throw new JarvisError("request_unresolved", "status", "Completion is rejected while Requests remain unresolved.");
    }
  }

  private checkAgentBinding(workSession: ProtocolRecord, actorId: string, spec: WsMutationSpec): void {
    const binding = spec.agent;
    if (!binding) {
      throw new JarvisError("missing_policy_decision", "policy_decision_id", "AgentWorker mutation requires a recorded PolicyDecision.");
    }
    const decision = this.getRecord("PolicyDecision", binding.policyDecisionId);
    if (!decision || decision.work_session_id !== workSession.id || decision.actor_id !== actorId) {
      throw new JarvisError("missing_policy_decision", "policy_decision_id", "PolicyDecision is missing or bound to another WorkSession or Actor.");
    }
    if (decision.requested_action?.action !== binding.action) {
      throw new JarvisError("approval_scope_mismatch", "policy_decision_id", `PolicyDecision covers ${decision.requested_action?.action}, not ${binding.action}.`);
    }
    const forBlockedScope = spec.agentCreatesRequest || binding.purpose === "blocked_scope";
    const allowedResults = forBlockedScope ? ["deny", "review_required", "narrow"] : ["allow", "narrow"];
    if (!allowedResults.includes(decision.result)) {
      throw new JarvisError(
        decision.result === "deny" ? "policy_denied" : "review_required",
        "policy_decision_id",
        `PolicyDecision result ${decision.result} does not authorize this mutation.`,
      );
    }
    this.checkTakeoverLock(workSession.id, binding.lockEpoch, decision.requested_action?.scope_ref);
  }

  private checkTakeoverLock(workSessionId: string, observedEpoch: number | undefined, scopeRef: string | undefined): void {
    const epoch = this.lockEpoch(workSessionId);
    if (observedEpoch !== undefined && observedEpoch < epoch) {
      throw new JarvisError("stale_takeover_epoch", "lock_epoch", `Agent action from lock epoch ${observedEpoch} is stale (current ${epoch}).`);
    }
    const blocking = this.listRecords(workSessionId, "Takeover").filter(
      (takeover) => ["requested", "locked", "human_active", "reconciliation_required"].includes(takeover.state),
    );
    for (const takeover of blocking) {
      const affected = takeover.affected_scope ?? {};
      if (affected.blocking_scope === "work_session" || (scopeRef && affected.scope_ref === scopeRef)) {
        throw new JarvisError("stale_takeover_epoch", "affected_scope", `Scope ${affected.scope_ref} is under human Takeover ${takeover.id}.`);
      }
    }
  }

  // ------------------------------------------------- protocol operations

  recordPolicyDecision(headers: JarvisHeaders, workSessionId: string, decision: ProtocolRecord, options: { lockEpoch?: number } = {}): MutationResult {
    return this.wsMutation({
      operationId: "recordPolicyDecision",
      headers,
      workSessionId,
      bodyActorId: decision.actor_id,
      body: decision,
      bodyRef: `PolicyDecision:${decision.id}`,
      eventType: "policy_decision.recorded",
      build: ({ workSession }) => {
        if (decision.work_session_id !== workSessionId || decision.policy_id !== workSession.policy_id) {
          throw new JarvisError("missing_policy", "policy_id", "PolicyDecision MUST reference the WorkSession Policy.");
        }
        this.checkTakeoverLock(workSessionId, options.lockEpoch, decision.requested_action?.scope_ref);
        const afterCommit = this.checkDecisionAgainstPolicy(workSession, decision);
        return {
          payload: {
            object_type: "policy_decision",
            object_id: decision.id,
            action: decision.result,
            summary: `PolicyDecision ${decision.result} for ${decision.requested_action.action}.`,
          },
          writes: [{ objectType: "PolicyDecision", record: decision }],
          afterCommit,
        };
      },
    });
  }

  /** Allow decisions bind to Policy allowed_actions or to a Review-approved ApprovalScope. */
  private checkDecisionAgainstPolicy(workSession: ProtocolRecord, decision: ProtocolRecord): (() => void) | undefined {
    const policy = this.requireRecord("Policy", workSession.policy_id, "policy_id");
    const action = decision.requested_action?.action;
    const names = (rules: ProtocolRecord[]) => rules.map((rule) => rule.action);
    if (decision.result !== "allow") {
      if ((decision.result === "deny" || decision.result === "review_required") && !decision.request_id) {
        throw new JarvisError("missing_policy_decision", "request_id", "deny and review_required decisions create or reference a Request.");
      }
      return undefined;
    }
    const approvalRef = (decision.selected_grant_refs ?? []).find((ref: string) => ref.startsWith("approval-scope:"));
    if (!approvalRef) {
      if (names(policy.denied_actions).includes(action) || names(policy.review_required_actions).includes(action) || !names(policy.allowed_actions).includes(action)) {
        throw new JarvisError("policy_denied", "result", `Policy does not allow ${action} without review.`);
      }
      return undefined;
    }
    if (names(policy.denied_actions).includes(action)) {
      throw new JarvisError("policy_denied", "result", `Policy explicitly denies ${action}; approval cannot override it.`);
    }
    const reviewId = approvalRef.slice("approval-scope:".length);
    const review = this.requireRecord("Review", reviewId, "selected_grant_refs");
    const scope = review.approval_scope;
    if (!scope || !["approve", "narrow"].includes(review.decision)) {
      throw new JarvisError("invalid_approval_scope", "selected_grant_refs", "Referenced Review grants no ApprovalScope.");
    }
    if (scope.applies_to_work_session_id !== workSession.id || scope.applies_to_actor_id !== decision.actor_id || scope.normalized_action_hash !== decision.normalized_action_hash || scope.approved_action?.action !== action) {
      throw new JarvisError("approval_scope_mismatch", "selected_grant_refs", "ApprovalScope does not match this action, Actor, or WorkSession.");
    }
    if (Date.parse(scope.expires_at) <= this.clock().getTime()) {
      throw new JarvisError("approval_scope_expired", "selected_grant_refs", "ApprovalScope expired.");
    }
    const uses = (this.db.prepare("SELECT uses FROM approval_uses WHERE review_id = ?").get(reviewId) as { uses: number } | undefined)?.uses ?? 0;
    if (uses >= scope.max_uses) {
      throw new JarvisError("invalid_approval_scope", "selected_grant_refs", "ApprovalScope max_uses exhausted.");
    }
    return () => {
      this.db
        .prepare("INSERT INTO approval_uses (review_id, uses) VALUES (?, 1) ON CONFLICT (review_id) DO UPDATE SET uses = uses + 1")
        .run(reviewId);
    };
  }

  createRequest(headers: JarvisHeaders, workSessionId: string, request: ProtocolRecord, binding: AgentActionBinding): MutationResult {
    return this.wsMutation({
      operationId: "createRequest",
      headers,
      workSessionId,
      bodyActorId: request.requester_actor_id,
      body: request,
      bodyRef: `Request:${request.id}`,
      eventType: "request.created",
      agent: binding,
      agentCreatesRequest: true,
      build: ({ workSession }) => {
        if (request.status !== "pending" || request.policy_decision_id !== binding.policyDecisionId) {
          throw new JarvisError("invalid_request_transition", "status", "New Requests are pending and bound to their PolicyDecision.");
        }
        if (request.target_human_worker_id !== workSession.human_worker_id) {
          throw new JarvisError("unauthorized_actor", "target_human_worker_id", "Request targets the WorkSession HumanWorker.");
        }
        this.checkLivelock(workSession, request);
        return {
          payload: {
            object_type: "request",
            object_id: request.id,
            action: "created",
            field_refs: [`blocking_scope:${request.blocking_scope}`, `policy_decision:${request.policy_decision_id}`],
            summary: request.reason_summary,
          },
          writes: [{ objectType: "Request", record: request }],
        };
      },
    });
  }

  private checkLivelock(workSession: ProtocolRecord, request: ProtocolRecord): void {
    const policy = this.requireRecord("Policy", workSession.policy_id, "policy_id");
    const requests = this.listRecords(workSession.id, "Request");
    const pending = requests.filter((r) => ["pending", "acknowledged"].includes(r.status));
    const maxPending = policy.request_limits?.max_pending_requests ?? 20;
    if (pending.length >= maxPending) {
      throw new JarvisError("request_livelock", "request_limits", "Too many pending Requests in this WorkSession.");
    }
    const decision = this.requireRecord("PolicyDecision", request.policy_decision_id, "policy_decision_id");
    const key = (r: ProtocolRecord) => {
      const pd = this.getRecord("PolicyDecision", r.policy_decision_id);
      return [r.target_human_worker_id, r.type, r.blocking_scope, r.risk_class, pd?.normalized_action_hash, contentHash(r.requested_action)].join("|");
    };
    const candidate = [request.target_human_worker_id, request.type, request.blocking_scope, request.risk_class, decision.normalized_action_hash, contentHash(request.requested_action)].join("|");
    if (pending.some((r) => key(r) === candidate)) {
      throw new JarvisError("request_livelock", "requested_action", "An identical Request is already pending.");
    }
    if (requests.some((r) => r.status === "denied" && key(r) === candidate)) {
      throw new JarvisError("request_livelock", "requested_action", "A denied Request cannot be recreated unchanged.");
    }
  }

  recordReview(headers: JarvisHeaders, workSessionId: string, review: ProtocolRecord): MutationResult {
    return this.wsMutation({
      operationId: "recordReview",
      headers,
      workSessionId,
      bodyActorId: review.reviewer_actor_id,
      body: review,
      bodyRef: `Review:${review.id}`,
      eventType: "review.recorded",
      build: ({ workSession, now }) => {
        const reviewer = this.requireActor(review.reviewer_actor_id);
        if (reviewer.type !== "human" || review.reviewer_worker_id !== workSession.human_worker_id) {
          throw new JarvisError("unauthorized_actor", "reviewer_actor_id", "Reviews record HumanWorker judgment.");
        }
        const writes: Write[] = [];
        const fieldRefs: string[] = [];
        if (typeof review.target_ref === "string" && review.target_ref.startsWith("request:")) {
          const requestId = review.target_ref.slice("request:".length);
          const request = this.requireRecord("Request", requestId, "target_ref");
          const status = REVIEW_TO_REQUEST_STATUS[review.decision];
          if (!REQUEST_TRANSITIONS[request.status]?.includes(status)) {
            throw new JarvisError("invalid_request_transition", "status", `Request ${request.status} -> ${status} is not allowed.`);
          }
          if (["approve", "narrow"].includes(review.decision)) this.checkApprovalScope(workSession, request, review);
          writes.push({ objectType: "Review", record: review, context: { request } });
          const resolved: ProtocolRecord = { ...request, status, resolved_at: now };
          if (status === "takeover") resolved.resolved_by_takeover_id = review.takeover_id;
          else resolved.resolved_by_review_id = review.id;
          writes.push({ objectType: "Request", record: resolved });
          fieldRefs.push(`request:${request.id}`, `request_status:${status}`);
        } else {
          writes.push({ objectType: "Review", record: review });
        }
        return {
          payload: {
            object_type: "review",
            object_id: review.id,
            action: review.decision,
            field_refs: fieldRefs,
            summary: `HumanWorker review: ${review.decision} on ${review.target_ref}.`,
          },
          writes,
        };
      },
    });
  }

  private checkApprovalScope(workSession: ProtocolRecord, request: ProtocolRecord, review: ProtocolRecord): void {
    const scope = review.approval_scope;
    if (!scope) throw new JarvisError("invalid_approval_scope", "approval_scope", "approve and narrow Reviews define an ApprovalScope.");
    const requestEvent = this.findEventFor(workSession.id, "request.created", request.id);
    const decision = this.requireRecord("PolicyDecision", request.policy_decision_id, "policy_decision_id");
    const agentActor = this.listRecordsByType("Actor").find((actor) => actor.worker_id === workSession.agent_worker_id);
    const mismatch =
      scope.request_id !== request.id ||
      scope.review_id !== review.id ||
      scope.policy_decision_id !== request.policy_decision_id ||
      !requestEvent ||
      scope.request_revision !== requestEvent.sequence ||
      scope.request_event_hash !== requestEvent.event_hash ||
      scope.normalized_action_hash !== decision.normalized_action_hash ||
      scope.applies_to_work_session_id !== workSession.id ||
      scope.applies_to_actor_id !== agentActor?.id ||
      scope.approved_action?.action !== request.requested_action?.action;
    if (mismatch) {
      throw new JarvisError("approval_scope_mismatch", "approval_scope", "ApprovalScope MUST bind the Request, its event, PolicyDecision, action hash, WorkSession, and AgentWorker Actor.");
    }
    if (!(scope.max_uses >= 1) || Date.parse(scope.expires_at) <= this.clock().getTime()) {
      throw new JarvisError("approval_scope_expired", "approval_scope.expires_at", "ApprovalScope must be bounded and unexpired.");
    }
  }

  /** Create a Takeover (increments the lock epoch) or move an existing one through its state machine. */
  recordTakeover(headers: JarvisHeaders, workSessionId: string, takeover: ProtocolRecord): MutationResult {
    const existing = this.getRecord("Takeover", takeover.id);
    const eventType = !existing ? "takeover.started" : ["resumed", "closed"].includes(takeover.state) ? "takeover.finished" : "takeover.updated";
    return this.wsMutation({
      operationId: "recordTakeover",
      headers,
      workSessionId,
      bodyActorId: takeover.controlling_actor_id,
      body: takeover,
      bodyRef: `Takeover:${takeover.id}`,
      eventType,
      build: () => {
        let record = takeover;
        let afterCommit: (() => void) | undefined;
        if (!existing) {
          const epoch = this.lockEpoch(workSessionId) + 1;
          record = { ...takeover, lock_epoch: epoch };
          afterCommit = () => {
            this.db.prepare("UPDATE host_sessions SET lock_epoch = ? WHERE work_session_id = ?").run(epoch, workSessionId);
          };
        } else {
          if (!TAKEOVER_TRANSITIONS[existing.state]?.includes(takeover.state)) {
            throw new JarvisError("invalid_transition", "state", `Takeover ${existing.state} -> ${takeover.state} is not allowed.`);
          }
          if (takeover.lock_epoch !== existing.lock_epoch) {
            throw new JarvisError("stale_takeover_epoch", "lock_epoch", "Takeover transitions keep their lock epoch.");
          }
          if (takeover.state === "resumed" && !(takeover.reconciliation_refs ?? []).length) {
            throw new JarvisError("missing_reconciliation_refs", "reconciliation_refs", "Resume requires reconciliation refs.");
          }
        }
        return {
          payload: {
            object_type: "takeover",
            object_id: takeover.id,
            action: takeover.state,
            field_refs: [`lock_epoch:${record.lock_epoch}`, `scope:${takeover.affected_scope?.scope_ref}`],
            summary: `Takeover ${takeover.state}.`,
          },
          writes: [{ objectType: "Takeover", record }],
          afterCommit,
        };
      },
    });
  }

  recordContribution(headers: JarvisHeaders, workSessionId: string, contribution: ProtocolRecord, binding?: AgentActionBinding): MutationResult {
    const actorId = String(headers["Jarvis-Actor-Id"]);
    return this.wsMutation({
      operationId: "recordContribution",
      headers,
      workSessionId,
      bodyActorId: contribution.contributor_refs?.some((ref: ProtocolRecord) => ref.actor_id === actorId) ? actorId : "",
      body: contribution,
      bodyRef: `Contribution:${contribution.id}`,
      eventType: "contribution.recorded",
      agent: binding,
      build: ({ workSession, eventId }) => {
        for (const ref of contribution.contributor_refs ?? []) {
          const actor = this.getRecord("Actor", ref.actor_id);
          if (!actor || actor.worker_id !== ref.worker_id || ![workSession.human_worker_id, workSession.agent_worker_id].includes(ref.worker_id)) {
            throw new JarvisError("invalid_contributor_refs", "contributor_refs", "Contributor refs MUST name WorkSession participants.");
          }
        }
        for (const ref of contribution.event_refs ?? []) {
          if (ref !== eventId && this.getEvent(ref)?.work_session_id !== workSessionId) {
            throw new JarvisError("missing_evidence_event_refs", "event_refs", `Event ${ref} is not in this WorkSession.`);
          }
        }
        return {
          payload: {
            object_type: "contribution",
            object_id: contribution.id,
            action: contribution.contribution_type,
            summary: `${contribution.contributor_type} contribution: ${contribution.contribution_type}.`,
          },
          writes: [{ objectType: "Contribution", record: contribution }],
        };
      },
    });
  }

  /**
   * appendJarvisEvent: artifact/evidence capture, WorkSession transitions,
   * Request closure, and memory confirmation. Record updates ride on the event.
   */
  appendJarvisEvent(
    headers: JarvisHeaders,
    workSessionId: string,
    input: {
      actor_id: string;
      type: string;
      payload: ProtocolRecord;
      status_to?: WorkSessionStatus;
      work_session_patch?: ProtocolRecord;
      writes?: (ctx: BuildContext) => Write[];
      afterCommit?: (ctx: BuildContext) => void;
    },
    binding?: AgentActionBinding,
  ): MutationResult {
    if (input.status_to && TRANSITION_EVENT[input.status_to] !== input.type) {
      throw new JarvisError("invalid_transition", "type", `Transition to ${input.status_to} uses ${TRANSITION_EVENT[input.status_to]}.`);
    }
    return this.wsMutation({
      operationId: "appendJarvisEvent",
      headers,
      workSessionId,
      bodyActorId: input.actor_id,
      body: { type: input.type, payload: input.payload, status_to: input.status_to ?? null, patch: input.work_session_patch ?? null },
      bodyRef: `JarvisEvent:${input.type}`,
      eventType: input.type,
      agent: binding,
      allowAfterTerminal: input.type === "work_session.closed",
      build: (ctx) => {
        const writes = input.writes?.(ctx) ?? [];
        for (const write of writes) this.checkGovernedUpdate(write, ctx.workSession);
        return {
          payload: input.payload,
          writes,
          statusTo: input.status_to,
          workSessionPatch: input.work_session_patch,
          afterCommit: input.afterCommit ? () => input.afterCommit!(ctx) : undefined,
        };
      },
    });
  }

  /** Guards record updates carried by appendJarvisEvent. */
  private checkGovernedUpdate(write: Write, workSession: ProtocolRecord): void {
    if (write.objectType === "Request") {
      const current = this.requireRecord("Request", write.record.id, "Request.id");
      if (current.status !== write.record.status && !REQUEST_TRANSITIONS[current.status]?.includes(write.record.status)) {
        throw new JarvisError("invalid_request_transition", "status", `Request ${current.status} -> ${write.record.status} is not allowed.`);
      }
      if (["expired", "cancelled", "superseded"].includes(write.record.status) && !write.record.closed_by_event_ref) {
        throw new JarvisError("missing_jarvis_event", "closed_by_event_ref", "Closed Requests reference the closing event.");
      }
    }
    if (write.objectType === "MemoryProposal" && write.record.status === "accepted") {
      const reviews = (write.record.review_refs ?? []).map((id: string) => this.getRecord("Review", id));
      const humanApproval = reviews.some((review: ProtocolRecord | null) => {
        if (!review || review.decision !== "approve" || review.work_session_id !== workSession.id) return false;
        return this.getRecord("Actor", review.reviewer_actor_id)?.type === "human";
      });
      if (!humanApproval) {
        throw new JarvisError("model_self_confirmed_memory", "review_refs", "Memory becomes durable only through HumanWorker Review.");
      }
    }
    if (write.objectType === "SkillProposal" && write.record.status === "accepted" && !(write.record.review_refs ?? []).length) {
      throw new JarvisError("silent_skill_activation", "review_refs", "Skills activate only through Review.");
    }
  }

  createLearningRecord(headers: JarvisHeaders, workSessionId: string, record: ProtocolRecord, binding?: AgentActionBinding): MutationResult {
    return this.proposalMutation("createLearningRecord", "learning.recorded", "LearningRecord", "learning_record", headers, workSessionId, record, record.created_by_actor_id, binding);
  }

  createMemoryProposal(headers: JarvisHeaders, workSessionId: string, record: ProtocolRecord, binding?: AgentActionBinding): MutationResult {
    if (record.status === "accepted" || record.review_required !== true) {
      throw new JarvisError("silent_memory_mutation", "status", "MemoryProposal starts unconfirmed and review_required.");
    }
    return this.proposalMutation("createMemoryProposal", "memory_proposal.created", "MemoryProposal", "memory_proposal", headers, workSessionId, record, record.proposed_by_actor_id, binding);
  }

  createSkillProposal(headers: JarvisHeaders, workSessionId: string, record: ProtocolRecord, binding?: AgentActionBinding): MutationResult {
    if (record.status === "accepted") {
      throw new JarvisError("silent_skill_activation", "status", "SkillProposal starts unreviewed.");
    }
    return this.proposalMutation("createSkillProposal", "skill_proposal.created", "SkillProposal", "skill_proposal", headers, workSessionId, record, record.proposed_by_actor_id, binding);
  }

  private proposalMutation(
    operationId: string,
    eventType: string,
    objectType: ObjectType,
    payloadType: string,
    headers: JarvisHeaders,
    workSessionId: string,
    record: ProtocolRecord,
    actorId: string,
    binding?: AgentActionBinding,
  ): MutationResult {
    return this.wsMutation({
      operationId,
      headers,
      workSessionId,
      bodyActorId: actorId,
      body: record,
      bodyRef: `${objectType}:${record.id}`,
      eventType,
      agent: binding,
      build: () => ({
        payload: { object_type: payloadType, object_id: record.id, action: "proposed", summary: `${objectType} proposed.` },
        writes: [{ objectType, record }],
      }),
    });
  }

  // ----------------------------------------------------- host-only helpers

  /** Host-private session data (job URL, master CV text, facts). Not a protocol record. */
  saveHostSession(workSessionId: string, data: { jobUrl: string; masterCv: string | null; facts: unknown }): void {
    this.db
      .prepare("INSERT INTO host_sessions (work_session_id, job_url, master_cv, candidate_facts, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(workSessionId, data.jobUrl, data.masterCv, JSON.stringify(data.facts ?? {}), this.nowIso());
  }

  getHostSession(workSessionId: string): { jobUrl: string; masterCv: string | null; facts: any; lockEpoch: number; state: any } | null {
    const row = this.db.prepare("SELECT * FROM host_sessions WHERE work_session_id = ?").get(workSessionId) as
      | Record<string, any>
      | undefined;
    if (!row) return null;
    return {
      jobUrl: row.job_url,
      masterCv: row.master_cv,
      facts: JSON.parse(row.candidate_facts),
      lockEpoch: row.lock_epoch,
      state: JSON.parse(row.state_json),
    };
  }

  setHostState(workSessionId: string, patch: Record<string, unknown>): void {
    const current = this.getHostSession(workSessionId)?.state ?? {};
    this.db
      .prepare("UPDATE host_sessions SET state_json = ? WHERE work_session_id = ?")
      .run(JSON.stringify({ ...current, ...patch }), workSessionId);
  }

  putArtifact(workSessionId: string, ref: string, kind: string, content: unknown): string {
    const hash = contentHash(content);
    this.db
      .prepare("INSERT OR IGNORE INTO artifacts (ref, work_session_id, kind, content_hash, json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ref, workSessionId, kind, hash, JSON.stringify(content), this.nowIso());
    return hash;
  }

  getArtifact(ref: string): { ref: string; kind: string; contentHash: string; content: any } | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE ref = ?").get(ref) as Record<string, string> | undefined;
    return row ? { ref: row.ref, kind: row.kind, contentHash: row.content_hash, content: JSON.parse(row.json) } : null;
  }

  listArtifacts(workSessionId: string): { ref: string; kind: string; contentHash: string; content: any }[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE work_session_id = ? ORDER BY rowid").all(workSessionId) as Record<string, string>[];
    return rows.map((row) => ({ ref: row.ref, kind: row.kind, contentHash: row.content_hash, content: JSON.parse(row.json) }));
  }

  writeMemory(proposal: ProtocolRecord): void {
    this.db
      .prepare("INSERT OR IGNORE INTO memory (id, memory_proposal_id, memory_scope, memory_type, content_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`memory-${randomUUID().slice(0, 8)}`, proposal.id, proposal.memory_scope, proposal.memory_type, JSON.stringify(proposal.content), this.nowIso());
  }

  listMemory(scope?: string): { memoryScope: string; memoryType: string; content: any; proposalId: string }[] {
    const rows = (scope
      ? this.db.prepare("SELECT * FROM memory WHERE memory_scope = ? ORDER BY rowid").all(scope)
      : this.db.prepare("SELECT * FROM memory ORDER BY rowid").all()) as Record<string, string>[];
    return rows.map((row) => ({ memoryScope: row.memory_scope, memoryType: row.memory_type, content: JSON.parse(row.content_json), proposalId: row.memory_proposal_id }));
  }
}
