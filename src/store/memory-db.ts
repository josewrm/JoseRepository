/**
 * In-memory stand-in for the subset of node:sqlite that RecordStore uses.
 * It serves the browser build (no SQLite available there). Every statement
 * RecordStore issues is handled explicitly; an unknown statement throws, so
 * a new query cannot silently misbehave. Tests run the store against both.
 */

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

export interface SqlStatement {
  get(...params: any[]): unknown;
  all(...params: any[]): unknown[];
  run(...params: any[]): unknown;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

const TABLES = ["records", "record_versions", "events", "idempotency", "operations", "artifacts", "host_sessions", "approval_uses", "memory"];

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

export class MemoryDatabase implements SqlDatabase {
  tables: Tables;
  private snapshot: string | null = null;
  private seq = 0;

  constructor(serialized?: string) {
    const parsed = serialized ? JSON.parse(serialized) : null;
    this.tables = parsed?.tables ?? Object.fromEntries(TABLES.map((t) => [t, []]));
    this.seq = parsed?.seq ?? 0;
  }

  serialize(): string {
    return JSON.stringify({ tables: this.tables, seq: this.seq });
  }

  exec(sql: string): void {
    const s = norm(sql).toUpperCase();
    if (s.startsWith("BEGIN")) this.snapshot = JSON.stringify(this.tables);
    else if (s === "COMMIT") this.snapshot = null;
    else if (s === "ROLLBACK") {
      if (this.snapshot) this.tables = JSON.parse(this.snapshot);
      this.snapshot = null;
    }
    // Schema statements are no-ops: tables exist from construction.
  }

  prepare(sql: string): SqlStatement {
    const handler = this.handler(norm(sql));
    if (!handler) throw new Error(`MemoryDatabase: unsupported statement: ${norm(sql)}`);
    return {
      get: (...p) => handler(p)[0],
      all: (...p) => handler(p),
      run: (...p) => {
        handler(p);
        return {};
      },
    };
  }

  private rows(table: string): Row[] {
    return this.tables[table];
  }

  private insert(table: string, row: Row): void {
    this.rows(table).push({ ...row, rowid: ++this.seq });
  }

  private handler(sql: string): ((p: any[]) => Row[]) | null {
    const r = (t: string) => this.rows(t);
    const byRowid = (a: Row, b: Row) => a.rowid - b.rowid;
    const pick = (row: Row | undefined, cols: string[] | "*") => (row ? (cols === "*" ? { ...row } : Object.fromEntries(cols.map((c) => [c, row[c]]))) : undefined);
    const list = (rows: Row[], cols: string[] | "*") => rows.map((row) => pick(row, cols)!) as Row[];

    switch (sql) {
      // records
      case "SELECT json FROM records WHERE object_type = ? AND id = ?":
        return ([t, id]) => list(r("records").filter((x) => x.object_type === t && x.id === id), ["json"]);
      case "SELECT version FROM records WHERE object_type = ? AND id = ?":
        return ([t, id]) => list(r("records").filter((x) => x.object_type === t && x.id === id), ["version"]);
      case "SELECT json FROM records WHERE object_type = ? ORDER BY rowid":
        return ([t]) => list(r("records").filter((x) => x.object_type === t).sort(byRowid), ["json"]);
      case "SELECT json FROM records WHERE work_session_id = ? AND object_type = ? ORDER BY rowid":
        return ([ws, t]) => list(r("records").filter((x) => x.work_session_id === ws && x.object_type === t).sort(byRowid), ["json"]);
      case "INSERT INTO records (object_type, id, work_session_id, version, json, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (object_type, id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at":
        return ([t, id, ws, version, json, at]) => {
          const existing = r("records").find((x) => x.object_type === t && x.id === id);
          if (existing) Object.assign(existing, { version, json, updated_at: at });
          else this.insert("records", { object_type: t, id, work_session_id: ws, version, json, updated_at: at });
          return [];
        };
      case "SELECT json FROM record_versions WHERE object_type = ? AND id = ? ORDER BY version":
        return ([t, id]) => list(r("record_versions").filter((x) => x.object_type === t && x.id === id).sort((a, b) => a.version - b.version), ["json"]);
      case "INSERT INTO record_versions (object_type, id, version, event_id, json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)":
        return ([t, id, version, event, json, at]) => {
          this.insert("record_versions", { object_type: t, id, version, event_id: event, json, recorded_at: at });
          return [];
        };
      // events
      case "SELECT json FROM events WHERE work_session_id = ? ORDER BY sequence":
        return ([ws]) => list(r("events").filter((x) => x.work_session_id === ws).sort((a, b) => a.sequence - b.sequence), ["json"]);
      case "SELECT json FROM events WHERE id = ?":
        return ([id]) => list(r("events").filter((x) => x.id === id), ["json"]);
      case "INSERT INTO events (work_session_id, sequence, id, type, actor_id, event_hash, previous_hash, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)":
        return ([ws, sequence, id, type, actor, hash, prev, json]) => {
          // Same uniqueness guarantees as the SQLite schema.
          if (r("events").some((x) => (x.work_session_id === ws && x.sequence === sequence) || x.id === id || x.event_hash === hash)) {
            throw new Error("UNIQUE constraint failed: events");
          }
          this.insert("events", { work_session_id: ws, sequence, id, type, actor_id: actor, event_hash: hash, previous_hash: prev, json });
          return [];
        };
      // idempotency
      case "SELECT * FROM idempotency WHERE idempotency_key = ?":
        return ([key]) => list(r("idempotency").filter((x) => x.idempotency_key === key), "*");
      case "INSERT INTO idempotency (idempotency_key, actor_id, protocol_version, operation_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)":
        return ([key, actor, version, op, hash, result, at]) => {
          if (r("idempotency").some((x) => x.idempotency_key === key)) throw new Error("UNIQUE constraint failed: idempotency");
          this.insert("idempotency", { idempotency_key: key, actor_id: actor, protocol_version: version, operation_id: op, payload_hash: hash, result_json: result, created_at: at });
          return [];
        };
      // operations
      case "INSERT INTO operations (work_session_id, operation_id, json) VALUES (?, ?, ?)":
        return ([ws, op, json]) => {
          this.insert("operations", { work_session_id: ws, operation_id: op, json });
          return [];
        };
      case "SELECT json FROM operations WHERE work_session_id = ? ORDER BY seq":
        return ([ws]) => list(r("operations").filter((x) => x.work_session_id === ws).sort(byRowid), ["json"]);
      case "SELECT json FROM operations WHERE work_session_id IS NULL AND operation_id IN ('registerWorker', 'registerActor') ORDER BY seq":
        return () => list(r("operations").filter((x) => x.work_session_id === null && ["registerWorker", "registerActor"].includes(x.operation_id)).sort(byRowid), ["json"]);
      // artifacts
      case "INSERT OR IGNORE INTO artifacts (ref, work_session_id, kind, content_hash, json, created_at) VALUES (?, ?, ?, ?, ?, ?)":
        return ([ref, ws, kind, hash, json, at]) => {
          if (!r("artifacts").some((x) => x.ref === ref)) this.insert("artifacts", { ref, work_session_id: ws, kind, content_hash: hash, json, created_at: at });
          return [];
        };
      case "SELECT * FROM artifacts WHERE ref = ?":
        return ([ref]) => list(r("artifacts").filter((x) => x.ref === ref), "*");
      case "SELECT * FROM artifacts WHERE work_session_id = ? ORDER BY rowid":
        return ([ws]) => list(r("artifacts").filter((x) => x.work_session_id === ws).sort(byRowid), "*");
      // host sessions
      case "INSERT INTO host_sessions (work_session_id, job_url, master_cv, candidate_facts, created_at) VALUES (?, ?, ?, ?, ?)":
        return ([ws, url, cv, facts, at]) => {
          this.insert("host_sessions", { work_session_id: ws, job_url: url, master_cv: cv, candidate_facts: facts, lock_epoch: 0, state_json: "{}", created_at: at });
          return [];
        };
      case "SELECT * FROM host_sessions WHERE work_session_id = ?":
        return ([ws]) => list(r("host_sessions").filter((x) => x.work_session_id === ws), "*");
      case "SELECT lock_epoch FROM host_sessions WHERE work_session_id = ?":
        return ([ws]) => list(r("host_sessions").filter((x) => x.work_session_id === ws), ["lock_epoch"]);
      case "UPDATE host_sessions SET lock_epoch = ? WHERE work_session_id = ?":
        return ([epoch, ws]) => {
          r("host_sessions").filter((x) => x.work_session_id === ws).forEach((x) => (x.lock_epoch = epoch));
          return [];
        };
      case "UPDATE host_sessions SET state_json = ? WHERE work_session_id = ?":
        return ([state, ws]) => {
          r("host_sessions").filter((x) => x.work_session_id === ws).forEach((x) => (x.state_json = state));
          return [];
        };
      // approval uses
      case "SELECT uses FROM approval_uses WHERE review_id = ?":
        return ([id]) => list(r("approval_uses").filter((x) => x.review_id === id), ["uses"]);
      case "INSERT INTO approval_uses (review_id, uses) VALUES (?, 1) ON CONFLICT (review_id) DO UPDATE SET uses = uses + 1":
        return ([id]) => {
          const row = r("approval_uses").find((x) => x.review_id === id);
          if (row) row.uses += 1;
          else this.insert("approval_uses", { review_id: id, uses: 1 });
          return [];
        };
      // memory
      case "INSERT OR IGNORE INTO memory (id, memory_proposal_id, memory_scope, memory_type, content_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?)":
        return ([id, proposal, scope, type, content, at]) => {
          if (!r("memory").some((x) => x.id === id || x.memory_proposal_id === proposal)) {
            this.insert("memory", { id, memory_proposal_id: proposal, memory_scope: scope, memory_type: type, content_json: content, accepted_at: at });
          }
          return [];
        };
      case "SELECT * FROM memory ORDER BY rowid":
        return () => list([...r("memory")].sort(byRowid), "*");
      case "SELECT * FROM memory WHERE memory_scope = ? ORDER BY rowid":
        return ([scope]) => list(r("memory").filter((x) => x.memory_scope === scope).sort(byRowid), "*");
      default:
        return null;
    }
  }
}

/** Runs fn inside a transaction. node:sqlite has no helper, so do it by hand. */
export function transaction<T>(db: SqlDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
