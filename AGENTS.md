# AGENTS.md — Apply2Interview host

This repository is **Apply2Interview**, a host that implements the Jarvis v0.1
protocol. Jarvis is the protocol (`../jarvis`, read-only). This repo is not Jarvis.

## Boundary

- This host owns: UI, storage (SQLite), auth (local HostAuth token), job fetching,
  CV files, scoring, section adaptation, email drafting, export packaging.
- Jarvis owns: protocol objects, state machines, headers, hash-chain rules,
  OpenAPI binding. See `../jarvis/AGENTS.md` and
  `../jarvis/docs/protocol/06-integration-boundaries.md`.
- Never add product workflow to the Jarvis repo. Never describe Jarvis as a
  framework, runtime, or harness.
- `@jarvis-protocol/sdk` is used only as a protocol helper (hashing, headers,
  validators). It is linked from `../jarvis/packages/typescript`.

## Non-negotiables

- Every WorkSession mutation goes through `src/store/record-store.ts` with the six
  Jarvis headers. Never write protocol tables directly.
- Every AgentWorker mutation is bound to a PolicyDecision recorded before it.
- Never invent JD facts, CV facts, or interview outcomes. Login wall or empty
  page → Request.
- Fit score and `apply_to_interview_pct` are computed, never by a model. "Before" uses
  each source CV; "after" uses the adapted CV, which may only contain lines from the
  candidate's own source CVs (truth guard), so no score comes from invention.
- `cvs_best_version` is a section patch. Lines from another source CV stay under the
  same role and in the same language. The truth guard hard-fails new facts.
- One click ("Aprobar y enviar") records one HumanWorker Review per open Request; the
  host sends only inside the approved email ApprovalScope (SMTP via env, else handoff).
- Sending is a Request. Nothing is sent without the human's click; never auto-submit
  to Workday, LinkedIn, or any ATS (forms are pre-filled for the human to paste).
- No credentials, auth tokens, or host-only ids in exports.

## Checks before every push

```bash
npm run typecheck
npm test            # includes Jarvis CLI validation of an exported pack
```

Architecture map: `docs/host-architecture.md`.
