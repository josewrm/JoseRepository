import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Host-owned storage. Jarvis does not prescribe storage; SQLite is this host's choice.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS records (
  object_type     TEXT NOT NULL,
  id              TEXT NOT NULL,
  work_session_id TEXT,
  version         INTEGER NOT NULL,
  json            TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (object_type, id)
);
CREATE INDEX IF NOT EXISTS records_ws ON records (work_session_id, object_type);

CREATE TABLE IF NOT EXISTS record_versions (
  object_type     TEXT NOT NULL,
  id              TEXT NOT NULL,
  version         INTEGER NOT NULL,
  event_id        TEXT,
  json            TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  PRIMARY KEY (object_type, id, version)
);

CREATE TABLE IF NOT EXISTS events (
  work_session_id TEXT NOT NULL,
  sequence        INTEGER NOT NULL,
  id              TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  event_hash      TEXT NOT NULL UNIQUE,
  previous_hash   TEXT NOT NULL,
  json            TEXT NOT NULL,
  PRIMARY KEY (work_session_id, sequence)
);

CREATE TABLE IF NOT EXISTS idempotency (
  idempotency_key  TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  operation_id     TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  result_json      TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  work_session_id TEXT,
  operation_id    TEXT NOT NULL,
  json            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  ref             TEXT PRIMARY KEY,
  work_session_id TEXT NOT NULL,
  kind            TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  json            TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- Host-private session data. Never exported as a protocol record.
CREATE TABLE IF NOT EXISTS host_sessions (
  work_session_id TEXT PRIMARY KEY,
  job_url         TEXT NOT NULL,
  master_cv       TEXT,
  candidate_facts TEXT NOT NULL,
  lock_epoch      INTEGER NOT NULL DEFAULT 0,
  state_json      TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);

-- Approval scope use counters (max_uses enforcement).
CREATE TABLE IF NOT EXISTS approval_uses (
  review_id       TEXT PRIMARY KEY,
  uses            INTEGER NOT NULL
);

-- Durable memory. Written only from an accepted MemoryProposal.
CREATE TABLE IF NOT EXISTS memory (
  id                  TEXT PRIMARY KEY,
  memory_proposal_id  TEXT NOT NULL UNIQUE,
  memory_scope        TEXT NOT NULL,
  memory_type         TEXT NOT NULL,
  content_json        TEXT NOT NULL,
  accepted_at         TEXT NOT NULL
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export { transaction } from "./memory-db.ts";
