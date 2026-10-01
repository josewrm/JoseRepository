// Thin host-side view of the Jarvis protocol helpers.
// The SDK is a protocol implementation kit: hashing, headers, validators.
// Everything else (storage, execution, workflow) stays in this host.
import * as sdk from "@jarvis-protocol/sdk";

// The host passes loosely typed protocol records; the SDK validates them at runtime.
type SdkResult = { valid: boolean; errors: any[] };
const loose = sdk as any;

export const PROTOCOL_VERSION: string = sdk.PROTOCOL_VERSION;
export const createJarvisEvent: (options: Record<string, any>) => ProtocolRecord = loose.createJarvisEvent;
export const createNonWorkSessionMutationHeaders: (options: Record<string, any>) => JarvisHeaders = loose.createNonWorkSessionMutationHeaders;
export const createWorkSessionMutationHeaders: (options: Record<string, any>) => JarvisHeaders = loose.createWorkSessionMutationHeaders;
export const createReadHeaders: (options: Record<string, any>) => JarvisHeaders = loose.createReadHeaders;
export const findForbiddenHostPrivateField: (value: unknown) => string | null = loose.findForbiddenHostPrivateField;
export const getOperationBinding: (operationId: string) => { method: string; path: string; statuses: number[] } = loose.getOperationBinding;
export const createOperationPath: (operationId: string, params: Record<string, string>) => string = loose.createOperationPath;
export const hashProtocolValue: (value: unknown) => string = loose.hashProtocolValue;
export const validateEventHashChain: (events: ProtocolRecord[], options?: Record<string, any>) => SdkResult = loose.validateEventHashChain;
export const validateEvidenceManifest: (manifest: ProtocolRecord, options?: Record<string, any>) => SdkResult = loose.validateEvidenceManifest;
export const validateMutationHeaders: (headers: JarvisHeaders, options?: Record<string, any>) => SdkResult = loose.validateMutationHeaders;
export const validateOperationHeaders: (operation: ProtocolRecord, options?: Record<string, any>) => SdkResult = loose.validateOperationHeaders;
export const validateProtocolRecord: (objectType: string, record: ProtocolRecord, options?: Record<string, any>) => SdkResult = loose.validateProtocolRecord;

export const GENESIS_HASH = "hash:protocol-genesis";

/** A portable protocol record. Shapes are locked by ../jarvis/docs/protocol/11-core-protocol-objects.md. */
export type ProtocolRecord = Record<string, any>;

export type ObjectType =
  | "Worker"
  | "Actor"
  | "HumanWorker"
  | "AgentWorker"
  | "WorkSession"
  | "JarvisEvent"
  | "Policy"
  | "PolicyDecision"
  | "Request"
  | "Review"
  | "Takeover"
  | "Contribution"
  | "EvidenceManifest"
  | "LearningRecord"
  | "MemoryProposal"
  | "SkillProposal"
  | "OutcomeReport";

export type JarvisHeaders = Record<string, any>;

export type WorkSessionStatus =
  | "active"
  | "waiting_on_human"
  | "takeover"
  | "reconciling"
  | "completed"
  | "failed"
  | "cancelled"
  | "closed";

export const TERMINAL_STATES: readonly WorkSessionStatus[] = ["completed", "failed", "cancelled", "closed"];

/** Allowed WorkSession transitions, from ../jarvis/docs/protocol/04-work-sessions.md. */
export const WORK_SESSION_TRANSITIONS: Record<WorkSessionStatus, WorkSessionStatus[]> = {
  active: ["waiting_on_human", "takeover", "completed", "failed", "cancelled"],
  waiting_on_human: ["active", "takeover", "completed", "failed", "cancelled"],
  takeover: ["reconciling", "failed", "cancelled"],
  reconciling: ["active", "waiting_on_human", "completed", "failed", "cancelled"],
  completed: ["closed"],
  failed: ["closed"],
  cancelled: ["closed"],
  closed: [],
};

export const TRANSITION_EVENT: Record<WorkSessionStatus, string> = {
  active: "work_session.activated",
  waiting_on_human: "work_session.waiting_on_human",
  takeover: "work_session.takeover",
  reconciling: "work_session.reconciling",
  completed: "work_session.completed",
  failed: "work_session.failed",
  cancelled: "work_session.cancelled",
  closed: "work_session.closed",
};

/** Allowed Request transitions, from ../jarvis/docs/protocol/12-request-protocol.md. */
export const REQUEST_TRANSITIONS: Record<string, string[]> = {
  pending: [
    "acknowledged", "approved", "denied", "narrowed", "answered", "needs_revision",
    "takeover", "expired", "cancelled", "superseded",
  ],
  acknowledged: [
    "approved", "denied", "narrowed", "answered", "needs_revision", "takeover",
    "expired", "cancelled", "superseded",
  ],
};

/** Review decision -> resulting Request status. */
export const REVIEW_TO_REQUEST_STATUS: Record<string, string> = {
  answer: "answered",
  approve: "approved",
  deny: "denied",
  narrow: "narrowed",
  correct: "needs_revision",
  needs_revision: "needs_revision",
  takeover: "takeover",
};

export const TAKEOVER_TRANSITIONS: Record<string, string[]> = {
  requested: ["locked", "closed"],
  locked: ["human_active", "reconciliation_required", "closed"],
  human_active: ["reconciliation_required", "closed"],
  reconciliation_required: ["resumed", "closed"],
  resumed: ["closed"],
  closed: [],
};

/** Protocol error carrying a Jarvis ProtocolErrorId. */
export class JarvisError extends Error {
  errorId: string;
  field: string;
  constructor(errorId: string, field: string, reason: string) {
    super(`${errorId}: ${reason}`);
    this.name = "JarvisError";
    this.errorId = errorId;
    this.field = field;
  }

  toProtocolError(traceId = "trace:apply2interview") {
    return {
      error_id: this.errorId,
      protocol_version: PROTOCOL_VERSION,
      object_type: "protocol",
      field: this.field,
      reason: this.message,
      remediation: "Resubmit a Jarvis v0.1 compatible mutation against the current WorkSession state.",
      trace_id: traceId,
    };
  }
}

/** Throws a JarvisError when an SDK validation result is invalid. */
export function assertSdkValid(result: { valid: boolean; errors: any[] }, context = ""): void {
  if (!result.valid) {
    const error = result.errors[0] ?? {};
    throw new JarvisError(
      error.error_id ?? "invalid_export",
      error.field ?? "",
      `${context}${context ? ": " : ""}${error.reason ?? "invalid protocol record"}`,
    );
  }
}

/** Content hash in the protocol `hash:` form over canonical JSON. */
export function contentHash(value: unknown): string {
  return hashProtocolValue(value);
}
