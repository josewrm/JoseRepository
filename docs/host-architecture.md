# Apply2Interview host architecture

Apply2Interview is a **host**. It implements the Jarvis v0.1 protocol contracts.
Jarvis is the protocol: it defines the collaboration record. It is not this
app, and this app adds no product behavior to the Jarvis repository.

```txt
../jarvis             protocol repo (read-only here). Records, rules, OpenAPI, SDK helpers.
./ (apply2interview)  host. UI, storage, auth, job fetching, CV files, scoring,
                      section adaptation, email drafting, export packaging.
```

The host uses `@jarvis-protocol/sdk` (linked from `../jarvis/packages/typescript`)
only as a protocol helper: canonical hashing, mutation headers, record
validators, event hash-chain checks. All execution, storage and product
workflow lives in this repository.

## Product in one line

One job link in. One governed WorkSession out.

## Ownership split

| Concern | Owner | Where in this repo |
| --- | --- | --- |
| Protocol objects, states, headers, hash chain rules | Jarvis | `../jarvis/docs/protocol/*` |
| Protocol record store (SQLite, append-only events, idempotency) | Host | `src/store/` |
| Policy content for this product | Host (HumanWorker owns it) | `src/policy/` |
| Fetching the job page, login-wall detection | Host | `src/adapters/job-link.ts` |
| JD structuring, CV parsing, fit score, percentage | Host | `src/scoring/` |
| CV section adaptation and truth guard | Host | `src/adapt/` |
| Email drafting (draft only) | Host | `src/email/` |
| AgentWorker loop (who calls what, in which order) | Host | `src/app/service.ts` |
| UI, local auth token | Host | `src/server/`, `public/` |
| Evidence export packaging | Host, validated against Jarvis | `src/export/` |

## Participants

| Product participant | Jarvis records |
| --- | --- |
| The candidate using the app | `Worker(type=human)` + `Actor(type=human)` + `HumanWorker` |
| The Apply2Interview agent (deterministic `heuristic_v1` code path) | `Worker(type=agent)` + `Actor(type=agent)` + `AgentWorker(autonomy_level=execute_with_review)` |

Actor `event_authority.allowed_event_types` is enforced by the store. The agent
Actor cannot record a Review, cannot confirm memory, and cannot complete the
WorkSession.

## Core loop mapped 1:1

| # | Product step | Jarvis object(s) | Event type(s) |
| --- | --- | --- | --- |
| 1 | Human pastes `job_url` (+ optional master CV, candidate facts). Intent: "from this link, prepare the best honest application." | `WorkSession` (objective, `source_ref=job-url:<sha256>`), `Contribution(human, intent)` | `work_session.created`, `contribution.recorded` |
| 2 | Policy: may fetch a public JD, score, propose section edits, draft email. May NOT send email, submit an application, or overwrite the master CV. | `Policy` (owned by the HumanWorker) | — (registered before the WorkSession) |
| 3 | Agent works inside policy: fetch JD, structure it, score, adapt sections, draft email. | `PolicyDecision(result=allow)` before each action, then artifacts + evidence | `policy_decision.recorded`, `artifact.created`, `evidence.captured` |
| 4 | Agent is blocked: login wall / empty page, CV patch needs a human choice, sending email. | `PolicyDecision(result=deny \| review_required)` + `Request` | `policy_decision.recorded`, `request.created`, `work_session.waiting_on_human` |
| 5 | Human approves, denies, narrows (keeps only some sections), answers (pastes the JD), corrects, or takes over (edits a section by hand). | `Review` (+ `ApprovalScope` on approve/narrow), `Takeover` | `review.recorded`, `request.resolved`, `takeover.started`, `takeover.finished` |
| 6 | Work continues inside the approved scope. | `PolicyDecision(result=allow)` bound to the ApprovalScope | `work_session.activated`, `policy_decision.recorded` |
| 7 | Who did what. | `Contribution` (human intent, agent research/artifact, human review/decision, shared final package) | `contribution.recorded` |
| 8 | Evidence: JD snapshot hash, CV section diff, score sheet, email draft hash. | `EvidenceItemRef` entries in `EvidenceManifest` | `evidence.captured` |
| 9 | Learning is proposed only. | `LearningRecord(review_state=proposed)`, `MemoryProposal(status=pending_review)`, `SkillProposal` (store support) | `learning.recorded`, `memory_proposal.created` |
| 9b | Human confirms or rejects a memory proposal. | `Request(type=review)` + `Review` → `MemoryProposal(status=accepted, review_refs)` | `request.created`, `review.recorded`, `memory.confirmed` |
| 10 | Outcome: submitted or not, later interview or rejection, only when the human records it. | `OutcomeReport` (non-WorkSession mutation, references a LearningRecord, never mutates the sealed export) | none (outside the sealed event log) |

## Product artifacts and how they become evidence

Artifacts are host-held content. Protocol records only carry opaque refs and
content hashes (`hash:<sha256 of canonical JSON>`).

| Product output | Artifact ref | EvidenceItemRef `evidence_type` | Gate |
| --- | --- | --- | --- |
| Raw JD snapshot (fetched text) | `artifact:jd-snapshot:<hash>` | `jd_snapshot` | PolicyDecision `fetch_public_jd` (allow) |
| Structured JD (English schema, original-language values) | `artifact:jd-structured:<hash>` | `jd_structured` | same |
| Fit score + `apply_to_interview_pct` + formula inputs | `artifact:score-sheet:<hash>` | `score_sheet` | PolicyDecision `score_fit` (allow) |
| `cvs_best_version` section patch | `artifact:cv-patch:v<n>:<hash>` | `cv_section_diff` | PolicyDecision `propose_cv_section_edits` (allow); acceptance via Review |
| Application email draft | `artifact:email-draft:<hash>` | `email_draft` | PolicyDecision `draft_application_email` (allow); sending via Request |

`score_sheet` stores every formula input so the percentage is reproducible from
the exported artifact. The EvidenceManifest binds that artifact by
`content_hash`.

## Policy (src/policy/apply2interview-policy.ts)

Deny by default. Explicit deny beats allow. Uncovered actions deny.

| Action | Result | Risk | Blocking scope when not allowed |
| --- | --- | --- | --- |
| `fetch_public_jd` | allow | low | — |
| `structure_jd` | allow | low | — |
| `score_fit` | allow | low | — |
| `propose_cv_section_edits` | allow | low | — |
| `draft_application_email` | allow | low | — |
| `capture_evidence`, `record_contribution`, `propose_learning` | allow | low | — |
| `use_human_supplied_jd` | review_required | medium | `branch` (login wall / empty page) |
| `accept_cv_version` | review_required | medium | `artifact` |
| `send_application_email` | review_required | high | `external_send` |
| `confirm_memory` | review_required | medium | `branch` |
| `submit_application` (Workday, LinkedIn, any ATS) | deny | critical | `final_submission` |
| `overwrite_master_cv` | deny | high | `artifact` |
| `fetch_authenticated_jd` (cookies, login) | deny | high | `branch` |

`send_application_email` stays `review_required` (the product's
"needs_human") until a Review with decision `approve` exists. The approved
ApprovalScope has `max_uses: 1`. Even then the host never sends mail on its own:
it hands the approved draft to the human (`mailto:` / copy) and the human
records that they sent it.

## Mutation discipline (src/store/record-store.ts)

Every WorkSession-scoped mutation carries and is checked against:

```txt
Authorization                         host auth (redacted in exports)
Jarvis-Protocol-Version               must be v0.1
Jarvis-Actor-Id                       must match the actor field in the body
Jarvis-Idempotency-Key                replay returns the original result
Jarvis-Request-Timestamp              rejected when outside the skew window
Jarvis-Expected-WorkSession-Revision  must equal WorkSession.revision
Jarvis-Previous-Event-Hash            must equal WorkSession.last_event_hash
```

Order of checks: headers present → protocol version → timestamp → idempotency
replay → closed/terminal state → revision → previous hash → actor authority →
PolicyDecision link for AgentWorker mutations → takeover lock epoch → apply.

One accepted mutation = one JarvisEvent = revision + 1. Events are hashed with
the SDK canonical JSON + sha256 and chained from `hash:protocol-genesis`.

Worker, Actor and OutcomeReport writes are non-WorkSession mutations: they carry
the first four Jarvis headers only.

## Storage (SQLite, host-owned)

```txt
records          latest version of each protocol record (object_type, id, work_session_id, json)
record_versions  append-only history of every record version
events           JarvisEvent log, unique (work_session_id, sequence) and unique event_hash
idempotency      key + actor + operation + payload hash -> original result
operations       operation envelopes (headers) for the export pack
artifacts        host-held artifact content keyed by ref, with content hash
host_sessions    host-private session data (job_url, CV text, facts, lock epoch)
memory           durable memory written only from an accepted MemoryProposal
```

Host-private data (`host_sessions`, raw CV text, auth token) never enters a
protocol record. Exports run `findForbiddenHostPrivateField` and the closed
OpenAPI schema checks from the SDK on every record.

## Honesty rules enforced in code

* JD: if the page is login-walled, blocked, or has no usable job text, the agent
  stops that branch and opens a `context` Request. It never invents a JD.
* Fit score and percentage are computed from the **master CV + candidate facts**,
  never from the adapted CV, so adaptation cannot raise them.
* Section adapter only reorders existing lines and may add one summary sentence
  built from terms that already appear in the master CV. The truth guard
  hard-fails if any edit introduces a token (employer, title, tool,
  certification, number, date, metric) absent from the master CV and candidate
  facts. Every patch entry carries `invented: false`.
* Email draft never contains the fit score, the percentage, or scoring words.
* No auto-submission to Workday, LinkedIn, ATS forms, or email.
* Exports never carry credentials, the auth token, or host-only ids.

## apply_to_interview_pct (heuristic_v1)

```txt
base = 8
+ must_have_coverage   * 28
+ seniority_match      * 12
+ domain_match         * 12
+ impact_evidence      * 10
+ ats_keyword_coverage * 8
+ constraint_fit       * 12
- 51 if any hard blocker, else 0
clamp 0..100, and cap at 49 when a legal or operational must-have is missing
bands: 70-100 strong, 50-69 solid, 30-49 stretch, 0-29 weak or blocked
```

Note: as specified, the weights sum to 90 (8+28+12+12+10+8+12), so the
maximum is 90 and the maximum with a hard blocker is 39. The explicit 49 cap is
kept as a backstop in case the weights change.

It is a heuristic, not a promise. Inputs and their definitions live in
`src/scoring/percentage.ts` and in every score sheet artifact.

## Evidence export (src/export/)

Export is valid only from a terminal WorkSession (`completed`, `failed`,
`cancelled`). It writes a pack in the same layout as
`../jarvis/docs/examples/evidence-packs/*`:

```txt
exports/<work_session_id>/
  records/*.json                 {object_type, record}
  events/event-chain.json        {events}
  evidence/evidence-manifest.json {evidence_manifest, work_session}
  headers/NN-<operation>.json    operation envelopes, Authorization redacted
  artifacts/*.json               host artifacts referenced by content hash
```

`npm run validate:export -- exports/<id>` runs the Jarvis CLI
(`validate record`, `validate evidence-manifest`, `check hash-chain`,
`check headers`) on the pack.

OutcomeReports are written to `outcome-reports/` next to the pack and never
modify it.

## Non-goals of this host

* No change to the Jarvis repository.
* No model call is required: every number is computed. A translation or LLM
  drafting provider can be added later behind an interface, recorded through
  `model_ref`/`prompt_ref` refs, and gated by the same Policy.
* No SMTP, no ATS automation.

## Three source CVs, evaluation, and one-click send

* The human gives up to three of their own CVs. Each is scored (`source_cv_scores`),
  adapted, and re-scored (`cv_evaluation`) against the 50% target.
* Adaptation may add lines from the other source CVs only when they are verbatim, in
  the same language, and (for experience bullets) under the same role (same dates and
  employer). The truth guard checks the union of the source CVs plus per-role lines.
* Adapted files are renamed `CV_<Name>_<Company>_<Title>[_<source>].md`.
* The application form is pre-filled from candidate facts, the CV header, and the
  posting; unknown fields stay empty and are listed as missing.
* "Aprobar y enviar" is one human click that records a Review (approve) on the CV
  Request and on the email Request. The send runs only inside the email
  ApprovalScope (`max_uses: 1`). The Node host sends through SMTP when `A2I_SMTP_URL`
  and `A2I_SMTP_FROM` are set and records an `email_sent_receipt`; otherwise, and in
  the browser edition, it hands the approved draft to the human.

## Personal assistant, job search, and batch Easy Apply

- **Profile** (host-private table `profile`): the three source CVs, candidate facts, default search. Not a protocol record.
- **Job search** (`src/adapters/job-search.ts`): LinkedIn's public `jobs-guest` endpoints, parsed with the card/detail parsers vendored from [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search) (MIT, `vendor/ai-job-search/`). One page per search, no login, no cookies. Results are host-private `job_leads`, ranked by overlap with terms in the candidate's own CVs.
- **LinkedIn job links**: `fetchJobPage` reads the public guest detail page for a `linkedin.com/jobs/view/<id>` link. A stub or missing description is a `login_wall` failure, so the agent opens a `use_human_supplied_jd` Request; it never invents a JD.
- **Prepare all**: one WorkSession per lead (`startSession` with the profile's CVs), so each job gets the full loop: JD, three adapted CVs, evaluation, form, draft.
- **Enviar todos · Easy Apply**: one human tap records **one approve Review per pending `accept_cv_version` Request**. It then lists each job link for the human to open. The human presses Easy Apply on LinkedIn and taps "Ya lo envié", which records a human `submission` Contribution (`markSubmittedExternally`). The host never submits on LinkedIn or an ATS: it's against LinkedIn's terms, risks the account, and is a hard ban for this host.
- **Voice or tap**: `src/app/commands.ts` parses Spanish, Portuguese and English commands such as "busca SAP EWM en Madrid", "prepara todos", "aprobar todos", "estado", and "abre empleos". The UI uses the Web Speech API when the browser allows the mic, and the text box and buttons otherwise.
