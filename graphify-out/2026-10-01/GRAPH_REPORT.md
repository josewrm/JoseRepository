# Graph Report - JoseRepository  (2026-10-01)

## Corpus Check
- 68 files · ~91,529 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 3, .css 1)

## Summary
- 755 nodes · 2112 edges · 41 communities (31 shown, 10 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 177 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `bde56ba7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- RecordStore
- Apply2InterviewService
- package.json
- app.js
- service.ts
- jarvis.ts
- section-adapter.ts
- MemoryDatabase
- job-link.ts
- score.ts
- graphify reference: query, path, explain
- cv-ewm-es.md
- ai-job-search/README.md
- assistant.test.ts
- Apply2Interview host architecture
- cv.ts
- truth-guard.ts
- assistant.ts
- browser/main.ts
- compilerOptions
- honesty.test.ts
- What You Must Do When Invoked
- apply2interview-policy.ts
- knowledge-graph.ts
- cv-english.md
- cv-general-es.md
- fake-cv.md
- AGENTS.md — Apply2Interview host
- Assistant
- assets.d.ts
- SqlStatement
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- graphify reference: incremental update and cluster-only
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- CLAUDE.md
- .claude/CLAUDE.md
- extraction-spec.md

## God Nodes (most connected - your core abstractions)
1. `RecordStore` - 73 edges
2. `ProtocolRecord` - 71 edges
3. `Apply2InterviewService` - 62 edges
4. `JarvisError` - 37 edges
5. `JarvisHeaders` - 27 edges
6. `buildEvidencePack()` - 26 edges
7. `Assistant` - 25 edges
8. `esc()` - 21 edges
9. `render()` - 21 edges
10. `contentHash()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Personal assistant, job search, and batch Easy Apply` --references--> `fetchJobPage()`  [INFERRED]
  docs/host-architecture.md → src/adapters/job-link.ts
- `server` --calls--> `validatePack()`  [EXTRACTED]
  src/server/main.ts → scripts/validate-export.ts
- `pipeline()` --calls--> `buildCvPatch()`  [EXTRACTED]
  test/honesty.test.ts → src/adapt/section-adapter.ts
- `JobLead` --inherits--> `JobCard`  [EXTRACTED]
  src/app/assistant.ts → vendor/ai-job-search/linkedin-search/helpers.ts
- `Assistant` --references--> `JobCard`  [EXTRACTED]
  src/app/assistant.ts → vendor/ai-job-search/linkedin-search/helpers.ts

## Import Cycles
- None detected.

## Communities (41 total, 10 thin omitted)

### Community 0 - "RecordStore"
Cohesion: 0.13
Nodes (4): JarvisError, JarvisHeaders, ProtocolRecord, RecordStore

### Community 1 - "Apply2InterviewService"
Cohesion: 0.15
Nodes (15): Personal assistant, job search, and batch Easy Apply, CvPatch, snapshotFromHumanText(), cvFilename(), Apply2InterviewService, factsText(), newId(), randomUUID() (+7 more)

### Community 2 - "package.json"
Cohesion: 0.07
Nodes (28): dependencies, @jarvis-protocol/sdk, nodemailer, description, devDependencies, esbuild, @types/node, @types/nodemailer (+20 more)

### Community 3 - "app.js"
Cohesion: 0.10
Nodes (53): api(), BAND, bind(), bindAssistant(), bindExplain(), busy(), chat, chips() (+45 more)

### Community 4 - "service.ts"
Cohesion: 0.11
Nodes (23): JobPageSnapshot, ApplicationForm, ascii(), fillApplicationForm(), FormField, SourceCvInput, AGENT_ACTOR_ID, AGENT_EVENT_TYPES (+15 more)

### Community 5 - "jarvis.ts"
Cohesion: 0.07
Nodes (57): ExportedPack, exportEvidencePack(), exportOutcomeReports(), buildEvidenceManifest(), buildEvidencePack(), EvidencePack, redactOperation(), slug() (+49 more)

### Community 6 - "section-adapter.ts"
Cohesion: 0.26
Nodes (18): adaptBlock(), AdaptOptions, adaptSkills(), adaptSummary(), applyPatch(), buildCvPatch(), linesWithHits(), matchingRoleLines() (+10 more)

### Community 7 - "MemoryDatabase"
Cohesion: 0.22
Nodes (6): load(), MemoryDatabase, norm(), Row, Tables, transaction()

### Community 8 - "job-link.ts"
Cohesion: 0.09
Nodes (36): decodeEntities(), ENTITIES, findJobPosting(), htmlToText(), jobPostingJsonLd(), pageTitle(), STOPWORDS, BLOCK_TEXT (+28 more)

### Community 9 - "score.ts"
Cohesion: 0.25
Nodes (16): isBullet(), textHasTerm(), contentWords(), evaluate(), factsText(), INPUT_DEFINITIONS, languageMatch(), locationMatch() (+8 more)

### Community 10 - "graphify reference: query, path, explain"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 11 - "cv-ewm-es.md"
Cohesion: 0.40
Nodes (4): Competencias, Experiencia, Idiomas, Perfil

### Community 13 - "assistant.test.ts"
Cohesion: 0.05
Nodes (48): esbuild, body, index, root, CheckResult, jarvisCliPath(), run(), validatePack() (+40 more)

### Community 14 - "Apply2Interview host architecture"
Cohesion: 0.13
Nodes (14): Apply2Interview host architecture, apply_to_interview_pct (heuristic_v1), Core loop mapped 1:1, Evidence export (src/export/), Honesty rules enforced in code, Mutation discipline (src/store/record-store.ts), Non-goals of this host, Ownership split (+6 more)

### Community 16 - "cv.ts"
Cohesion: 0.21
Nodes (12): CvSection, CvSectionKind, DATE_RANGE, experienceYears(), headingInfo(), KIND_PATTERNS, MONTHS, parseCv() (+4 more)

### Community 17 - "truth-guard.ts"
Cohesion: 0.23
Nodes (12): ALL_PREFIXES, checkTruth(), GuardInput, isTemplateLine(), itemSetKey(), normalizeLine(), sentenceSetKey(), SKILL_TEMPLATE_PREFIXES (+4 more)

### Community 18 - "assistant.ts"
Cohesion: 0.10
Nodes (29): detectLanguage(), LeadStatus, Intent, PAGES, parseCommand(), recase(), strip(), categorize() (+21 more)

### Community 19 - "browser/main.ts"
Cohesion: 0.10
Nodes (14): assistant, db, deps, EXAMPLE_DETAILS, EXAMPLE_FACTS, EXAMPLE_LEADS, EXAMPLE_SOURCES, fetchImpl (+6 more)

### Community 20 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 21 - "honesty.test.ts"
Cohesion: 0.16
Nodes (16): assertNoScore(), draftEmail(), EmailDraft, EmailGuardError, Template, TEMPLATES, TITLE_PLACEHOLDER, applyToInterviewPct() (+8 more)

### Community 22 - "What You Must Do When Invoked"
Cohesion: 0.08
Nodes (24): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+16 more)

### Community 23 - "apply2interview-policy.ts"
Cohesion: 0.20
Nodes (9): ActionRule, ALLOWED, BlockingScope, buildPolicyRecord(), DENIED, PolicyEvaluation, PolicyResult, REVIEW_REQUIRED (+1 more)

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

### Community 31 - "Assistant"
Cohesion: 0.10
Nodes (16): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000) (+8 more)

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
- **227 isolated node(s):** `name`, `version`, `private`, `description`, `license` (+222 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 272 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RecordStore` connect `RecordStore` to `Apply2InterviewService`, `service.ts`, `jarvis.ts`, `assistant.test.ts`, `browser/main.ts`, `Assistant`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `Apply2InterviewService` connect `Apply2InterviewService` to `RecordStore`, `service.ts`, `jarvis.ts`, `job-link.ts`, `assistant.test.ts`, `assistant.ts`, `browser/main.ts`, `Assistant`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `ProtocolRecord` connect `RecordStore` to `Apply2InterviewService`, `service.ts`, `jarvis.ts`, `apply2interview-policy.ts`, `knowledge-graph.ts`?**
  _High betweenness centrality (0.046) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _227 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `RecordStore` be split into smaller, more focused modules?**
  _Cohesion score 0.1284722222222222 - nodes in this community are weakly interconnected._
- **Should `Apply2InterviewService` be split into smaller, more focused modules?**
  _Cohesion score 0.1496562665256478 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.06896551724137931 - nodes in this community are weakly interconnected._