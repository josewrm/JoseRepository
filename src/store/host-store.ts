import type { SqlDatabase } from "./memory-db.ts";

/** Host-private assistant data: the candidate profile and jobs found. Not protocol records. */
export class HostStore {
  db: SqlDatabase;
  clock: () => Date;
  constructor(db: SqlDatabase, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  getProfile<T>(): T | null {
    const row = this.db.prepare("SELECT json FROM profile WHERE id = ?").get("me") as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  }

  saveProfile(profile: unknown): void {
    this.db
      .prepare("INSERT INTO profile (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
      .run("me", JSON.stringify(profile), this.clock().toISOString());
  }

  listLeads<T>(): T[] {
    return (this.db.prepare("SELECT json FROM job_leads ORDER BY rowid").all() as { json: string }[]).map((r) => JSON.parse(r.json) as T);
  }

  getLead<T>(id: string): T | null {
    const row = this.db.prepare("SELECT json FROM job_leads WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : null;
  }

  saveLead<T extends { id: string }>(lead: T): void {
    this.db
      .prepare("INSERT INTO job_leads (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at")
      .run(lead.id, JSON.stringify(lead), this.clock().toISOString());
  }
}
