# Graph Report - JoseRepository  (2026-10-01)

## Corpus Check
- 61 files · ~82,623 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 2, .css 1)

## Summary
- 658 nodes · 1794 edges · 44 communities (36 shown, 8 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 147 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9c45d474`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ProtocolRecord
- Apply2InterviewService
- package.json
- app.js
- service.ts
- jarvis.ts
- section-adapter.ts
- MemoryDatabase
- job-link.ts
- score.ts
- server/main.ts
- http.ts
- buildEvidencePack
- record-store.test.ts
- Apply2Interview host architecture
- helpers.ts
- cv.ts
- truth-guard.ts
- jd.ts
- browser/main.ts
- compilerOptions
- honesty.test.ts
- What You Must Do When Invoked
- apply2interview-policy.ts
- percentage.ts
- ref_node_assert
- knowledge-graph.ts
- cv-english.md
- cv-general-es.md
- fake-cv.md
- AGENTS.md — Apply2Interview host
- graphify reference: extra exports and benchmark
- assets.d.ts
- memory-db.ts
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- CLAUDE.md
- .claude/CLAUDE.md
- extraction-spec.md

## God Nodes (most connected - your core abstractions)
1. `ProtocolRecord` - 71 edges
2. `RecordStore` - 71 edges
3. `Apply2InterviewService` - 56 edges
4. `JarvisError` - 37 edges
5. `JarvisHeaders` - 27 edges
6. `buildEvidencePack()` - 26 edges
7. `contentHash()` - 18 edges
8. `buildCvPatch()` - 16 edges
9. `scoreFit()` - 16 edges
10. `esc()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `server` --calls--> `validatePack()`  [EXTRACTED]
  src/server/main.ts → scripts/validate-export.ts
- `pipeline()` --calls--> `buildCvPatch()`  [EXTRACTED]
  test/honesty.test.ts → src/adapt/section-adapter.ts
- `makeService()` --calls--> `Apply2InterviewService`  [EXTRACTED]
  test/helpers.ts → src/app/service.ts
- `pipeline()` --calls--> `parseCv()`  [EXTRACTED]
  test/honesty.test.ts → src/scoring/cv.ts
- `pipeline()` --calls--> `structureJd()`  [EXTRACTED]
  test/honesty.test.ts → src/scoring/jd.ts

## Import Cycles
- None detected.

## Communities (44 total, 8 thin omitted)

### Community 0 - "ProtocolRecord"
Cohesion: 0.11
Nodes (9): createJarvisEvent, JarvisError, JarvisHeaders, ProtocolRecord, WorkSessionStatus, SqlDatabase, transaction(), BuildResult (+1 more)

### Community 1 - "Apply2InterviewService"
Cohesion: 0.16
Nodes (14): CvPatch, snapshotFromHumanText(), cvFilename(), Apply2InterviewService, factsText(), newId(), randomUUID(), short() (+6 more)

### Community 2 - "package.json"
Cohesion: 0.06
Nodes (31): dependencies, @jarvis-protocol/sdk, nodemailer, description, devDependencies, esbuild, @types/node, @types/nodemailer (+23 more)

### Community 3 - "app.js"
Cohesion: 0.15
Nodes (34): api(), BAND, bind(), bindExplain(), busy(), chips(), copyText(), download() (+26 more)

### Community 4 - "service.ts"
Cohesion: 0.09
Nodes (29): nodemailer, JobPageSnapshot, ApplicationForm, ascii(), fillApplicationForm(), FormField, normalizeSources(), SourceCvInput (+21 more)

### Community 5 - "jarvis.ts"
Cohesion: 0.13
Nodes (21): createNonWorkSessionMutationHeaders, createOperationPath, GENESIS_HASH, getOperationBinding, hashProtocolValue, loose, ObjectType, REQUEST_TRANSITIONS (+13 more)

### Community 6 - "section-adapter.ts"
Cohesion: 0.24
Nodes (20): adaptBlock(), AdaptOptions, adaptSkills(), adaptSummary(), applyPatch(), buildCvPatch(), linesWithHits(), matchingRoleLines() (+12 more)

### Community 7 - "MemoryDatabase"
Cohesion: 0.17
Nodes (8): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal, load(), MemoryDatabase, norm()

### Community 8 - "job-link.ts"
Cohesion: 0.18
Nodes (17): decodeEntities(), ENTITIES, findJobPosting(), htmlToText(), jobPostingJsonLd(), pageTitle(), STOPWORDS, BLOCK_TEXT (+9 more)

### Community 9 - "score.ts"
Cohesion: 0.25
Nodes (15): textHasTerm(), contentWords(), evaluate(), factsText(), INPUT_DEFINITIONS, languageMatch(), locationMatch(), MatchStatus (+7 more)

### Community 10 - "server/main.ts"
Cohesion: 0.19
Nodes (11): CheckResult, jarvisCliPath(), run(), validatePack(), db, mailer, port, root (+3 more)

### Community 11 - "http.ts"
Cohesion: 0.16
Nodes (17): exportOutcomeReports(), PROTOCOL_VERSION, createAppServer(), PUBLIC_DIR, readJson(), sameSecret(), send(), ServerOptions (+9 more)

### Community 12 - "buildEvidencePack"
Cohesion: 0.22
Nodes (17): ExportedPack, exportEvidencePack(), buildEvidenceManifest(), buildEvidencePack(), EvidencePack, redactOperation(), slug(), PackCheck (+9 more)

### Community 13 - "record-store.test.ts"
Cohesion: 0.19
Nodes (11): HUMAN_ACTOR_ID, normalizedActionHash(), pages, FACTS, fixture(), JOB_URL, LOGIN_URL, pages (+3 more)

### Community 14 - "Apply2Interview host architecture"
Cohesion: 0.13
Nodes (14): Apply2Interview host architecture, apply_to_interview_pct (heuristic_v1), Core loop mapped 1:1, Evidence export (src/export/), Honesty rules enforced in code, Mutation discipline (src/store/record-store.ts), Non-goals of this host, Ownership split (+6 more)

### Community 15 - "helpers.ts"
Cohesion: 0.25
Nodes (8): openDatabase(), AUTH, fakeFetch(), FIXTURES, makeService(), FACTS, pages, SOURCES

### Community 16 - "cv.ts"
Cohesion: 0.23
Nodes (11): CvSection, CvSectionKind, DATE_RANGE, experienceYears(), headingInfo(), KIND_PATTERNS, MONTHS, parseCv() (+3 more)

### Community 17 - "truth-guard.ts"
Cohesion: 0.23
Nodes (12): ALL_PREFIXES, checkTruth(), GuardInput, isTemplateLine(), itemSetKey(), normalizeLine(), sentenceSetKey(), SKILL_TEMPLATE_PREFIXES (+4 more)

### Community 18 - "jd.ts"
Cohesion: 0.13
Nodes (23): detectLanguage(), categorize(), cleanBullet(), firstHeading(), hasUsableRequirements(), HEADING_PATTERNS, headingKind(), Requirement (+15 more)

### Community 19 - "browser/main.ts"
Cohesion: 0.12
Nodes (15): db, deps, EXAMPLE_FACTS, EXAMPLE_SOURCES, fetchImpl, nativeFetch, ready, save() (+7 more)

### Community 20 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 21 - "honesty.test.ts"
Cohesion: 0.27
Nodes (9): assertNoScore(), draftEmail(), EmailDraft, EmailGuardError, Template, TEMPLATES, TITLE_PLACEHOLDER, FACTS (+1 more)

### Community 22 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 23 - "apply2interview-policy.ts"
Cohesion: 0.20
Nodes (9): ActionRule, ALLOWED, BlockingScope, buildPolicyRecord(), DENIED, PolicyEvaluation, PolicyResult, REVIEW_REQUIRED (+1 more)

### Community 24 - "percentage.ts"
Cohesion: 0.32
Nodes (7): applyToInterviewPct(), band, clamp01(), FORMULA_TEXT, PercentageInputs, round2(), WEIGHTS

### Community 25 - "ref_node_assert"
Cohesion: 0.28
Nodes (4): createHash(), K, randomUUID(), sha256Hex()

### Community 26 - "knowledge-graph.ts"
Cohesion: 0.17
Nodes (14): SourceCv, buildKnowledgeGraph(), clip(), Confidence, GraphCommunity, GraphEdge, GraphInput, GraphNode (+6 more)

### Community 27 - "cv-english.md"
Cohesion: 0.33
Nodes (5): Education, Experience, Languages, Skills, Summary

### Community 28 - "cv-general-es.md"
Cohesion: 0.33
Nodes (5): Competencias, Experiencia, Formación, Idiomas, Perfil

### Community 29 - "fake-cv.md"
Cohesion: 0.33
Nodes (5): Education, Experience, Languages, Skills, Summary

### Community 30 - "AGENTS.md — Apply2Interview host"
Cohesion: 0.40
Nodes (4): AGENTS.md — Apply2Interview host, Boundary, Checks before every push, Non-negotiables

### Community 31 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 35 - "memory-db.ts"
Cohesion: 0.29
Nodes (3): Row, SqlStatement, Tables

### Community 36 - "graphify reference: add a URL and watch a folder"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 37 - "graphify reference: commit hook and native CLAUDE.md integration"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 38 - "graphify reference: incremental update and cluster-only"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

## Knowledge Gaps
- **214 isolated node(s):** `name`, `version`, `private`, `description`, `license` (+209 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 248 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RecordStore` connect `ProtocolRecord` to `Apply2InterviewService`, `service.ts`, `jarvis.ts`, `server/main.ts`, `buildEvidencePack`, `record-store.test.ts`, `helpers.ts`, `browser/main.ts`?**
  _High betweenness centrality (0.065) - this node is a cross-community bridge._
- **Why does `ProtocolRecord` connect `ProtocolRecord` to `Apply2InterviewService`, `service.ts`, `jarvis.ts`, `http.ts`, `buildEvidencePack`, `apply2interview-policy.ts`, `knowledge-graph.ts`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Why does `Apply2InterviewService` connect `Apply2InterviewService` to `ProtocolRecord`, `service.ts`, `server/main.ts`, `http.ts`, `helpers.ts`, `browser/main.ts`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _214 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ProtocolRecord` be split into smaller, more focused modules?**
  _Cohesion score 0.10985915492957747 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.05714285714285714 - nodes in this community are weakly interconnected._
- **Should `service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08712121212121213 - nodes in this community are weakly interconnected._