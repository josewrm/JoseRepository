# Apply2Interview

One job link in. One governed WorkSession out.

Apply2Interview is a **host** that implements the
[Jarvis](https://github.com/Flow-Research/jarvis) v0.1 human-agent collaboration
protocol. You paste a job link; an agent prepares the best honest application
under your Policy. Anything outside that Policy becomes a Request for you to
approve, deny, narrow, answer, correct, or take over. Every step is a
hash-chained Jarvis event with evidence you can export.

See [docs/host-architecture.md](docs/host-architecture.md) for the map from
product steps to Jarvis objects.

## What you get

1. **Structured JD**: the schema is in English and the values are verbatim. If the page is login-walled or empty, the agent opens a `context` Request and does not invent a JD.
2. **Fit score** against your master CV, with verbatim evidence quotes.
3. **`cvs_best_version`**: a section patch (summary, skills, and 2–4 touched roles) that only reorders your own lines. A truth guard hard-fails any new fact.
4. **Application email draft** in the posting's language. The app never sends it. Sending is a Request; once you approve it, you get the draft to send yourself.
5. **`apply_to_interview_pct`** (`heuristic_v1`): a computed heuristic with the formula and inputs shown. It is not a promise.

## Run

Requires Node ≥ 22.18 (it uses `node:sqlite` and native TypeScript type stripping).

```bash
git clone https://github.com/Flow-Research/jarvis.git ../jarvis   # protocol, sibling dir
npm install
npm start            # http://127.0.0.1:8787
npm test             # includes Jarvis CLI validation of an export
npm run typecheck
npm run validate:export -- exports/<work_session_id>
```

Environment variables: `PORT`, `HOST` (default `127.0.0.1`), `A2I_DB`
(SQLite path, default `data/apply2interview.sqlite`), and `A2I_HOST_TOKEN`
(otherwise a random token is generated per run).

## Browser edition

`npm run build:artifact` builds `dist/apply2interview.html`, one self-contained page
running the same host code in the browser. It keeps an in-memory store saved to
localStorage, validates the export pack in-process with the Jarvis SDK, and has a
bundled example job page. Without a server it cannot fetch other job pages, so the
agent opens a Request and you paste the job description.

## Layout

```txt
src/store/      protocol record store: headers, revision, hash chain, idempotency, PolicyDecision binding, takeover epochs
src/policy/     the Apply2Interview Policy (deny by default)
src/adapters/   public job-page fetcher + login-wall/empty detection
src/scoring/    JD structuring, CV parsing, fit score, heuristic_v1 percentage
src/adapt/      section adapter + truth guard
src/email/      email drafter (posting language, no scores)
src/app/        the WorkSession loop (AgentWorker + HumanWorker actions)
src/export/     evidence pack export (same layout as ../jarvis/docs/examples/evidence-packs)
src/server/     transport-free API routes + Node HTTP server
src/browser/    browser edition entry (in-page API, localStorage, sha256 shim)
public/         minimal UI
test/           golden honesty tests, store rules, end-to-end slice
```

The master CV is accepted as plain text or Markdown. `.docx`/PDF import is not
in this slice.
