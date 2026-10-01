import { contentHash, type ProtocolRecord } from "../protocol/jarvis.ts";

/**
 * The Apply2Interview Policy. The HumanWorker owns it; the host evaluates it.
 * Deny by default. Explicit deny beats allow. Uncovered actions deny.
 */

export type PolicyResult = "allow" | "deny" | "review_required";
export type RiskClass = "low" | "medium" | "high" | "critical";
export type BlockingScope = "action" | "branch" | "artifact" | "tool_call" | "external_send" | "final_submission" | "work_session";

export interface ActionRule {
  action: string;
  scope_ref: string;
  risk_class: RiskClass;
  blocking_scope: BlockingScope;
  /** Jarvis risk taxonomy from 03-autonomy-policy.md, recorded as a grant ref. */
  risk_taxonomy: string;
}

export const ALLOWED: ActionRule[] = [
  { action: "fetch_public_jd", scope_ref: "scope:public-job-page", risk_class: "low", blocking_scope: "tool_call", risk_taxonomy: "network_fetch" },
  { action: "structure_jd", scope_ref: "scope:local-worksession", risk_class: "low", blocking_scope: "action", risk_taxonomy: "write_local" },
  { action: "score_fit", scope_ref: "scope:local-worksession", risk_class: "low", blocking_scope: "action", risk_taxonomy: "read_private" },
  { action: "propose_cv_section_edits", scope_ref: "scope:cv-proposal", risk_class: "low", blocking_scope: "artifact", risk_taxonomy: "write_local" },
  { action: "draft_application_email", scope_ref: "scope:email-draft", risk_class: "low", blocking_scope: "artifact", risk_taxonomy: "write_local" },
  { action: "capture_evidence", scope_ref: "scope:local-worksession", risk_class: "low", blocking_scope: "action", risk_taxonomy: "write_local" },
  { action: "record_contribution", scope_ref: "scope:local-worksession", risk_class: "low", blocking_scope: "action", risk_taxonomy: "write_local" },
  { action: "propose_learning", scope_ref: "scope:learning-proposal", risk_class: "low", blocking_scope: "action", risk_taxonomy: "write_local" },
];

export const REVIEW_REQUIRED: ActionRule[] = [
  { action: "use_human_supplied_jd", scope_ref: "scope:jd-source", risk_class: "medium", blocking_scope: "branch", risk_taxonomy: "read_private" },
  { action: "accept_cv_version", scope_ref: "scope:cv-acceptance", risk_class: "medium", blocking_scope: "artifact", risk_taxonomy: "write_local" },
  { action: "send_application_email", scope_ref: "scope:external-email", risk_class: "high", blocking_scope: "external_send", risk_taxonomy: "send_external" },
  { action: "confirm_memory", scope_ref: "scope:durable-memory", risk_class: "medium", blocking_scope: "branch", risk_taxonomy: "write_local" },
];

export const DENIED: ActionRule[] = [
  { action: "submit_application", scope_ref: "scope:ats-submission", risk_class: "critical", blocking_scope: "final_submission", risk_taxonomy: "public_publish" },
  { action: "overwrite_master_cv", scope_ref: "scope:master-cv", risk_class: "high", blocking_scope: "artifact", risk_taxonomy: "destructive" },
  { action: "fetch_authenticated_jd", scope_ref: "scope:authenticated-job-page", risk_class: "high", blocking_scope: "branch", risk_taxonomy: "credentialed" },
];

export function buildPolicyRecord(input: { id: string; ownerWorkerId: string; createdByActorId: string; createdAt: string }): ProtocolRecord {
  const rule = (r: ActionRule) => ({ action: r.action, scope_ref: r.scope_ref, grant_refs: [`grant:${r.action}`, `risk:${r.risk_taxonomy}`] });
  return {
    id: input.id,
    owner_worker_id: input.ownerWorkerId,
    created_by_actor_id: input.createdByActorId,
    autonomy_level: "execute_with_review",
    allowed_actions: ALLOWED.map(rule),
    denied_actions: DENIED.map((r) => ({ action: r.action, scope_ref: r.scope_ref })),
    review_required_actions: REVIEW_REQUIRED.map((r) => ({ action: r.action, scope_ref: r.scope_ref })),
    risk_classes: ["low", "medium", "high", "critical"],
    escalation_rules: [
      { trigger: "job_page_login_wall_or_empty", risk_class: "medium", required_action: "create_request", reviewer_ref: input.ownerWorkerId, reason: "The agent never invents a JD; the HumanWorker supplies one or cancels." },
      { trigger: "cv_section_patch_ready", risk_class: "medium", required_action: "create_request", reviewer_ref: input.ownerWorkerId, reason: "The HumanWorker chooses the accepted CV version." },
      { trigger: "external_send", risk_class: "high", required_action: "create_request", reviewer_ref: input.ownerWorkerId, reason: "Email sending stays needs_human until Review approves it." },
      { trigger: "durable_memory_change", risk_class: "medium", required_action: "create_request", reviewer_ref: input.ownerWorkerId, reason: "Nothing becomes memory until the HumanWorker confirms." },
    ],
    created_at: input.createdAt,
    tool_grants: ALLOWED.map((r) => `grant:${r.action}`),
    memory_grants: ["grant:read-confirmed-memory"],
    external_send_rules: [{ action: "send_application_email", scope_ref: "scope:external-email" }],
    request_limits: { max_pending_requests: 6, max_repeated_denials: 1, default_expiry_seconds: 7 * 24 * 3600 },
  };
}

export interface PolicyEvaluation {
  result: PolicyResult;
  rule: ActionRule;
  reason: string;
}

/** Evaluates an action name against the Policy record. Deny by default. */
export function evaluate(policy: ProtocolRecord, action: string): PolicyEvaluation {
  const has = (rules: ProtocolRecord[]) => rules.some((r) => r.action === action);
  const known = [...ALLOWED, ...REVIEW_REQUIRED, ...DENIED].find((r) => r.action === action);
  const fallback: ActionRule = known ?? { action, scope_ref: "scope:uncovered", risk_class: "high", blocking_scope: "action", risk_taxonomy: "uncovered" };
  if (has(policy.denied_actions)) return { result: "deny", rule: fallback, reason: `Policy explicitly denies ${action}.` };
  if (has(policy.review_required_actions)) return { result: "review_required", rule: fallback, reason: `Policy requires HumanWorker review before ${action}.` };
  if (has(policy.allowed_actions)) return { result: "allow", rule: fallback, reason: `Policy allows ${action} inside ${fallback.scope_ref}.` };
  return { result: "deny", rule: fallback, reason: `${action} is not covered by Policy; uncovered actions deny.` };
}

/** Deterministic action hash binding PolicyDecision, Request, Review, and ApprovalScope. */
export function normalizedActionHash(requestedAction: ProtocolRecord): string {
  return contentHash({ action: requestedAction.action, target_ref: requestedAction.target_ref ?? null, scope_ref: requestedAction.scope_ref ?? null });
}
