# Graph Report - JoseRepository  (2026-10-01)

## Corpus Check
- 48 files · ~70,822 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: (none) 1, .css 1)

## Summary
- 581 nodes · 1702 edges · 35 communities (32 shown, 3 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 146 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `9c45d474`
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
- lexicon.ts
- apply2interview-policy.ts
- percentage.ts
- ref_node_assert
- routes.ts
- cv-english.md
- cv-general-es.md
- fake-cv.md
- AGENTS.md — Apply2Interview host
- cv-ewm-es.md
- assets.d.ts

## God Nodes (most connected - your core abstractions)
1. `RecordStore` - 71 edges
2. `ProtocolRecord` - 69 edges
3. `Apply2InterviewService` - 56 edges
4. `JarvisError` - 37 edges
5. `JarvisHeaders` - 27 edges
6. `buildEvidencePack()` - 26 edges
7. `contentHash()` - 18 edges
8. `buildCvPatch()` - 16 edges
9. `scoreFit()` - 16 edges
10. `MemoryDatabase` - 14 edges

## Surprising Connections (you probably didn't know these)
- `server` --calls--> `validatePack()`  [EXTRACTED]
  src/server/main.ts → scripts/validate-export.ts
- `pipeline()` --calls--> `buildCvPatch()`  [EXTRACTED]
  test/honesty.test.ts → src/adapt/section-adapter.ts
- `pipeline()` --calls--> `snapshotFromHtml()`  [EXTRACTED]
  test/honesty.test.ts → src/adapters/job-link.ts
- `makeService()` --calls--> `Apply2InterviewService`  [EXTRACTED]
  test/helpers.ts → src/app/service.ts
- `pipeline()` --calls--> `parseCv()`  [EXTRACTED]
  test/honesty.test.ts → src/scoring/cv.ts

## Import Cycles
- None detected.

## Communities (35 total, 3 thin omitted)

### Community 0 - "RecordStore"
Cohesion: 0.12
Nodes (7): createJarvisEvent, JarvisError, JarvisHeaders, ProtocolRecord, WorkSessionStatus, BuildResult, RecordStore

### Community 1 - "Apply2InterviewService"
Cohesion: 0.16
Nodes (13): CvPatch, cvFilename(), Apply2InterviewService, factsText(), newId(), randomUUID(), short(), UserError (+5 more)

### Community 2 - "package.json"
Cohesion: 0.06
Nodes (31): dependencies, @jarvis-protocol/sdk, nodemailer, description, devDependencies, esbuild, @types/node, @types/nodemailer (+23 more)

### Community 3 - "app.js"
Cohesion: 0.16
Nodes (32): api(), BAND, bind(), busy(), copyText(), directives(), download(), esc() (+24 more)

### Community 4 - "service.ts"
Cohesion: 0.11
Nodes (24): ApplicationForm, ascii(), fillApplicationForm(), FormField, normalizeSources(), SourceCvInput, AGENT_ACTOR_ID, AGENT_EVENT_TYPES (+16 more)

### Community 5 - "jarvis.ts"
Cohesion: 0.13
Nodes (21): createNonWorkSessionMutationHeaders, createOperationPath, GENESIS_HASH, getOperationBinding, hashProtocolValue, loose, ObjectType, REQUEST_TRANSITIONS (+13 more)

### Community 6 - "section-adapter.ts"
Cohesion: 0.24
Nodes (20): adaptBlock(), AdaptOptions, adaptSkills(), adaptSummary(), applyPatch(), buildCvPatch(), linesWithHits(), matchingRoleLines() (+12 more)

### Community 7 - "MemoryDatabase"
Cohesion: 0.14
Nodes (7): MemoryDatabase, norm(), Row, SqlDatabase, SqlStatement, Tables, transaction()

### Community 8 - "job-link.ts"
Cohesion: 0.18
Nodes (17): decodeEntities(), ENTITIES, findJobPosting(), htmlToText(), jobPostingJsonLd(), pageTitle(), STOPWORDS, BLOCK_TEXT (+9 more)

### Community 9 - "score.ts"
Cohesion: 0.20
Nodes (18): categorize(), Requirement, textHasTerm(), contentWords(), evaluate(), factsText(), INPUT_DEFINITIONS, languageMatch() (+10 more)

### Community 10 - "server/main.ts"
Cohesion: 0.14
Nodes (14): nodemailer, CheckResult, jarvisCliPath(), run(), validatePack(), Mailer, smtpMailerFromEnv(), db (+6 more)

### Community 11 - "http.ts"
Cohesion: 0.21
Nodes (13): ExportedPack, exportEvidencePack(), exportOutcomeReports(), createAppServer(), PUBLIC_DIR, readJson(), sameSecret(), send() (+5 more)

### Community 12 - "buildEvidencePack"
Cohesion: 0.26
Nodes (15): buildEvidenceManifest(), buildEvidencePack(), EvidencePack, redactOperation(), slug(), PackCheck, validatePackFiles(), assertSdkValid() (+7 more)

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
Cohesion: 0.19
Nodes (13): SourceCv, CvSection, CvSectionKind, DATE_RANGE, experienceYears(), headingInfo(), KIND_PATTERNS, MONTHS (+5 more)

### Community 17 - "truth-guard.ts"
Cohesion: 0.23
Nodes (12): ALL_PREFIXES, checkTruth(), GuardInput, isTemplateLine(), itemSetKey(), normalizeLine(), sentenceSetKey(), SKILL_TEMPLATE_PREFIXES (+4 more)

### Community 18 - "jd.ts"
Cohesion: 0.20
Nodes (13): detectLanguage(), JobPageSnapshot, cleanBullet(), firstHeading(), hasUsableRequirements(), HEADING_PATTERNS, headingKind(), RequirementCategory (+5 more)

### Community 19 - "browser/main.ts"
Cohesion: 0.15
Nodes (12): db, deps, EXAMPLE_FACTS, EXAMPLE_SOURCES, fetchImpl, load(), nativeFetch, ready (+4 more)

### Community 20 - "compilerOptions"
Cohesion: 0.14
Nodes (13): compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, lib, module, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 21 - "honesty.test.ts"
Cohesion: 0.27
Nodes (9): assertNoScore(), draftEmail(), EmailDraft, EmailGuardError, Template, TEMPLATES, TITLE_PLACEHOLDER, FACTS (+1 more)

### Community 22 - "lexicon.ts"
Cohesion: 0.24
Nodes (10): aliasRegex(), ALL_TERMS, CERTIFICATION_TERMS, compiled, DOMAIN_TERMS, escapeRegex(), findTerms(), LANGUAGE_NAMES (+2 more)

### Community 23 - "apply2interview-policy.ts"
Cohesion: 0.20
Nodes (9): ActionRule, ALLOWED, BlockingScope, buildPolicyRecord(), DENIED, PolicyEvaluation, PolicyResult, REVIEW_REQUIRED (+1 more)

### Community 24 - "percentage.ts"
Cohesion: 0.24
Nodes (9): applyToInterviewPct(), band, clamp01(), FORMULA_TEXT, PercentageInputs, PercentageResult, round2(), WEIGHTS (+1 more)

### Community 25 - "ref_node_assert"
Cohesion: 0.28
Nodes (4): createHash(), K, randomUUID(), sha256Hex()

### Community 26 - "routes.ts"
Cohesion: 0.29
Nodes (6): PROTOCOL_VERSION, ApiRequest, ApiResponse, Handler, PackResult, RouteDeps

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

### Community 31 - "cv-ewm-es.md"
Cohesion: 0.40
Nodes (4): Competencias, Experiencia, Idiomas, Perfil

## Knowledge Gaps
- **165 isolated node(s):** `name`, `version`, `private`, `description`, `license` (+160 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 188 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `RecordStore` connect `RecordStore` to `Apply2InterviewService`, `service.ts`, `jarvis.ts`, `MemoryDatabase`, `server/main.ts`, `http.ts`, `buildEvidencePack`, `record-store.test.ts`, `helpers.ts`, `browser/main.ts`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `ProtocolRecord` connect `RecordStore` to `Apply2InterviewService`, `service.ts`, `jarvis.ts`, `http.ts`, `buildEvidencePack`, `apply2interview-policy.ts`, `routes.ts`?**
  _High betweenness centrality (0.062) - this node is a cross-community bridge._
- **Why does `Apply2InterviewService` connect `Apply2InterviewService` to `RecordStore`, `service.ts`, `server/main.ts`, `http.ts`, `helpers.ts`, `browser/main.ts`, `routes.ts`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _165 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `RecordStore` be split into smaller, more focused modules?**
  _Cohesion score 0.11985526910900045 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.05714285714285714 - nodes in this community are weakly interconnected._
- **Should `service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10541310541310542 - nodes in this community are weakly interconnected._