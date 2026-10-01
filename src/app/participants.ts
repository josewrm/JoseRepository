import type { ProtocolRecord } from "../protocol/jarvis.ts";

// Participant records for this single-user host install.

export const HUMAN_WORKER_ID = "worker-human-candidate";
export const HUMAN_ACTOR_ID = "actor-human-candidate";
export const AGENT_WORKER_ID = "worker-agent-apply2interview";
export const AGENT_ACTOR_ID = "actor-agent-apply2interview";
export const POLICY_ID = "policy-apply2interview-v1";

export const HUMAN_EVENT_TYPES = [
  "work_session.created",
  "work_session.activated",
  "work_session.completed",
  "work_session.cancelled",
  "work_session.failed",
  "work_session.closed",
  "contribution.recorded",
  "review.recorded",
  "request.closed",
  "evidence.captured",
  "learning.recorded",
  "memory.confirmed",
  "memory.rejected",
  "takeover.started",
  "takeover.updated",
  "takeover.finished",
];

export const AGENT_EVENT_TYPES = [
  "policy_decision.recorded",
  "request.created",
  "evidence.captured",
  "contribution.recorded",
  "work_session.waiting_on_human",
  "learning.recorded",
  "memory_proposal.created",
  "skill_proposal.created",
];

export function participantRecords(createdAt: string, agentRef: string): {
  humanWorker: ProtocolRecord;
  agentWorker: ProtocolRecord;
  humanActor: ProtocolRecord;
  agentActor: ProtocolRecord;
  humanProfile: ProtocolRecord;
  agentProfile: ProtocolRecord;
} {
  return {
    humanWorker: {
      id: HUMAN_WORKER_ID,
      type: "human",
      role: "candidate, policy owner, and reviewer",
      authority_scope: { grants: ["policy:own", "review:approve", "review:narrow", "review:deny", "takeover:start", "memory:confirm"] },
      accountability_scope: { accountable_for: ["objective", "policy", "final_review", "application_submission"] },
      display_name: "Candidate",
      capabilities: [{ ref: "capability:human_judgment", capability_type: "human_judgment", required: true }],
    },
    agentWorker: {
      id: AGENT_WORKER_ID,
      type: "agent",
      role: "application preparation agent",
      authority_scope: { grants: ["action:execute_after_policy", "evidence:capture", "request:create", "learning:propose"] },
      accountability_scope: { accountable_for: ["policy_checked_execution", "evidence_capture", "honest_artifacts"] },
      display_name: "Apply2Interview agent",
      capabilities: [
        { ref: "capability:public_jd_reader", capability_type: "research", required: true },
        { ref: "capability:fit_scoring_heuristic_v1", capability_type: "analysis", required: true },
        { ref: "capability:cv_section_adapter", capability_type: "drafting", required: true },
        { ref: "capability:email_drafter", capability_type: "drafting", required: true },
      ],
    },
    humanActor: {
      id: HUMAN_ACTOR_ID,
      worker_id: HUMAN_WORKER_ID,
      type: "human",
      event_authority: { can_append_events: true, allowed_event_types: HUMAN_EVENT_TYPES },
      contribution_scope: { contribution_roles: ["human", "shared"] },
      created_at: createdAt,
      valid_from: createdAt,
    },
    agentActor: {
      id: AGENT_ACTOR_ID,
      worker_id: AGENT_WORKER_ID,
      type: "agent",
      event_authority: { can_append_events: true, allowed_event_types: AGENT_EVENT_TYPES },
      contribution_scope: { contribution_roles: ["agent", "shared"] },
      created_at: createdAt,
      valid_from: createdAt,
    },
    humanProfile: {
      worker_id: HUMAN_WORKER_ID,
      actor_id: HUMAN_ACTOR_ID,
      role: "policy owner and reviewer",
      policy_authority: { grants: ["policy:own", "policy:narrow"] },
      review_authority: { grants: ["review:approve", "review:narrow", "review:deny", "review:answer", "takeover:start", "memory:confirm"] },
      profile_ref: "profile:candidate",
      boundaries: [
        "never send email or submit applications without my approval",
        "never invent CV facts",
        "never overwrite my master CV",
      ],
    },
    agentProfile: {
      worker_id: AGENT_WORKER_ID,
      actor_id: AGENT_ACTOR_ID,
      agent_ref: agentRef,
      role: "bounded application preparation agent",
      capability_refs: [
        { ref: "capability:public_jd_reader", capability_type: "research", required: true },
        { ref: "capability:fit_scoring_heuristic_v1", capability_type: "analysis", required: true },
        { ref: "capability:cv_section_adapter", capability_type: "drafting", required: true },
        { ref: "capability:email_drafter", capability_type: "drafting", required: true },
      ],
      autonomy_level: "execute_with_review",
      operating_constraints: [
        "record PolicyDecision before every action that changes the WorkSession",
        "create a Request when the job page is login-walled or empty; never invent a JD",
        "CV edits are section patches built only from master CV lines",
        "email is draft only; sending requires an approved Review",
        "never submit to Workday, LinkedIn, or any ATS",
      ],
      tool_access_profile: "tool-profile:public-fetch-only",
      memory_access_profile: "memory-profile:confirmed-only",
    },
  };
}
