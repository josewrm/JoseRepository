import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Apply2InterviewService, UserError } from "../app/service.ts";
import { HUMAN_ACTOR_ID } from "../app/participants.ts";
import { JarvisError, PROTOCOL_VERSION } from "../protocol/jarvis.ts";
import { TruthGuardError } from "../adapt/truth-guard.ts";
import { EmailGuardError } from "../email/drafter.ts";
import { buildEvidenceManifest, exportEvidencePack, exportOutcomeReports } from "../export/evidence-export.ts";

const PUBLIC_DIR = resolve(import.meta.dirname, "../../public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export interface ServerOptions {
  service: Apply2InterviewService;
  /** Host auth token. The UI receives it in the page; the API requires it. */
  token: string;
  exportDir: string;
  outcomeDir: string;
  validatePack?: (dir: string) => { command: string; file: string; ok: boolean; output: string }[];
}

class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(typeof body === "string" ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8"): void {
  const payload = typeof body === "string" && !type.startsWith("application/json") ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new HttpError(413, { error: "Body too large (2 MB max)." });
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, { error: "Body must be JSON." });
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof HttpError) return { status: error.status, body: error.body };
  if (error instanceof UserError) return { status: error.status, body: { error: error.message } };
  if (error instanceof TruthGuardError) return { status: 422, body: { error: error.message, violations: error.violations } };
  if (error instanceof EmailGuardError) return { status: 422, body: { error: error.message } };
  if (error instanceof JarvisError) return { status: 409, body: { error: error.message, protocol_error: error.toProtocolError() } };
  console.error(error);
  return { status: 500, body: { error: "Internal error" } };
}

export function createAppServer(options: ServerOptions): Server {
  const { service, token } = options;
  const authHeader = `HostAuth ${token}`;

  const routes: [string, RegExp, (m: RegExpMatchArray, body: any, req: IncomingMessage, res: ServerResponse) => Promise<unknown> | unknown][] = [
    ["GET", /^\/api\/sessions$/, () => ({ sessions: service.listSessions() })],
    ["POST", /^\/api\/sessions$/, async (_m, body) => {
      const id = await service.startSession({ job_url: String(body.job_url ?? ""), master_cv: body.master_cv ?? null, candidate_facts: body.candidate_facts ?? {} });
      return service.view(id);
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)$/, (m) => service.view(m[1])],
    ["POST", /^\/api\/sessions\/([\w-]+)\/requests\/([\w-]+)\/review$/, async (m, body) => {
      await service.review(m[1], m[2], body);
      return service.view(m[1]);
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/email-sent$/, (m, body) => {
      service.markEmailSent(m[1], body.note);
      return service.view(m[1]);
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/learning$/, (m) => {
      service.proposeLearning(m[1]);
      return service.view(m[1]);
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/complete$/, (m) => {
      service.complete(m[1]);
      return service.view(m[1]);
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/cancel$/, (m) => {
      service.cancel(m[1]);
      return service.view(m[1]);
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/outcome$/, (m, body) => {
      const report = service.recordOutcome(m[1], { outcome: String(body.outcome ?? ""), note: body.note });
      exportOutcomeReports(service.store, m[1], options.outcomeDir);
      return { outcome_report: report, view: service.view(m[1]) };
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/export$/, (m) => {
      const pack = exportEvidencePack(service.store, m[1], options.exportDir, HUMAN_ACTOR_ID);
      const checks = options.validatePack?.(pack.dir) ?? [];
      return {
        dir: pack.dir,
        files: pack.files,
        manifest: pack.manifest,
        jarvis_cli: { total: checks.length, passed: checks.filter((c) => c.ok).length, failures: checks.filter((c) => !c.ok) },
      };
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)\/export\.json$/, (m, _b, _req, res) => {
      const pack = exportEvidencePack(service.store, m[1], options.exportDir, HUMAN_ACTOR_ID);
      const bundle = Object.fromEntries(pack.files.map((file) => [file, JSON.parse(readFileSync(join(pack.dir, file), "utf8"))]));
      res.setHeader("content-disposition", `attachment; filename="${m[1]}-evidence-pack.json"`);
      return bundle;
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)\/cv\/accepted\.md$/, (m, _b, _req, res) => {
      const accepted = service.view(m[1]).artifacts.accepted_cv;
      if (!accepted) throw new HttpError(404, { error: "No accepted CV version yet." });
      res.setHeader("content-disposition", `attachment; filename="${m[1]}-cv-accepted.md"`);
      return { __text: accepted.text };
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)\/cv\/patch\.json$/, (m, _b, _req, res) => {
      const patches = service.view(m[1]).artifacts.cv_patches;
      if (!patches.length) throw new HttpError(404, { error: "No CV patch." });
      res.setHeader("content-disposition", `attachment; filename="${m[1]}-cvs-best-version.json"`);
      return patches[patches.length - 1].patch;
    }],
    ["GET", /^\/api\/memory$/, () => ({ memory: service.store.listMemory() })],
    // Read-only Jarvis binding surface (requires Jarvis read headers).
    ["GET", /^\/jarvis\/work-sessions\/([\w-]+)$/, (m) => {
      const ws = service.store.getWorkSession(m[1]);
      if (!ws) throw new HttpError(404, { error: "Unknown WorkSession" });
      return ws;
    }],
    ["GET", /^\/jarvis\/work-sessions\/([\w-]+)\/export$/, (m) => buildEvidenceManifest(service.store, m[1], HUMAN_ACTOR_ID)],
  ];

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8").replace("__HOST_AUTH_TOKEN__", token);
        return send(res, 200, html, TYPES[".html"]);
      }
      if (req.method === "GET" && /^\/(app\.js|styles\.css)$/.test(url.pathname)) {
        const file = join(PUBLIC_DIR, url.pathname.slice(1));
        if (existsSync(file)) return send(res, 200, readFileSync(file, "utf8"), TYPES[url.pathname.slice(url.pathname.lastIndexOf("."))]);
      }
      const isApi = url.pathname.startsWith("/api/");
      const isJarvis = url.pathname.startsWith("/jarvis/");
      if (!isApi && !isJarvis) return send(res, 404, { error: "Not found" });
      if (!sameSecret(String(req.headers.authorization ?? ""), authHeader)) return send(res, 401, { error: "Missing or invalid HostAuth token." });
      if (isJarvis) {
        if (req.headers["jarvis-protocol-version"] !== PROTOCOL_VERSION) return send(res, 400, new JarvisError("missing_protocol_version", "headers.Jarvis-Protocol-Version", "Jarvis read operations require Jarvis-Protocol-Version.").toProtocolError());
        if (req.headers["jarvis-actor-id"] !== HUMAN_ACTOR_ID) return send(res, 400, new JarvisError("unauthorized_actor", "headers.Jarvis-Actor-Id", "Unknown reading Actor.").toProtocolError());
      }
      if (req.method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
        return send(res, 415, { error: "Use application/json." });
      }
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (!match || req.method !== method) continue;
        const body = req.method === "POST" ? await readJson(req) : {};
        const result: any = await handler(match, body, req, res);
        if (result && typeof result === "object" && "__text" in result) return send(res, 200, result.__text, "text/markdown; charset=utf-8");
        return send(res, 200, result);
      }
      return send(res, 404, { error: "Not found" });
    } catch (error) {
      const { status, body } = errorResponse(error);
      return send(res, status, body);
    }
  });
}
