import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { Apply2InterviewService } from "../app/service.ts";
import type { Assistant } from "../app/assistant.ts";
import { HUMAN_ACTOR_ID } from "../app/participants.ts";
import { exportEvidencePack, exportOutcomeReports } from "../export/evidence-export.ts";
import { buildEvidencePack } from "../export/evidence-pack.ts";
import { HttpError, errorResponse, handleApi, type PackResult } from "./routes.ts";

const PUBLIC_DIR = resolve(import.meta.dirname, "../../public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

export interface ServerOptions {
  service: Apply2InterviewService;
  assistant?: Assistant;
  /** Host auth token. The UI receives it in the page; the API requires it. */
  token: string;
  exportDir: string;
  outcomeDir: string;
  validatePack?: (dir: string) => { command: string; file: string; ok: boolean; output: string }[];
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8", filename?: string): void {
  const payload = typeof body === "string" && !type.startsWith("application/json") ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(filename ? { "content-disposition": `attachment; filename="${filename}"` } : {}),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 20_000_000) throw new HttpError(413, { error: "Body too large (20 MB max)." });
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

export function createAppServer(options: ServerOptions): Server {
  const { service, token } = options;
  const authHeader = `HostAuth ${token}`;
  const deps = {
    service,
    assistant: options.assistant,
    exportPack: (wsId: string): PackResult => {
      const written = exportEvidencePack(service.store, wsId, options.exportDir, HUMAN_ACTOR_ID);
      const files = buildEvidencePack(service.store, wsId, HUMAN_ACTOR_ID).files;
      return { location: written.dir, files, manifest: written.manifest, checks: options.validatePack?.(written.dir) ?? [], validator: "Jarvis CLI" };
    },
    onOutcome: (wsId: string) => {
      exportOutcomeReports(service.store, wsId, options.outcomeDir);
    },
  };

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
      if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/jarvis/")) return send(res, 404, { error: "Not found" });
      if (!sameSecret(String(req.headers.authorization ?? ""), authHeader)) return send(res, 401, { error: "Missing or invalid HostAuth token." });
      if (req.method === "POST" && !String(req.headers["content-type"] ?? "").includes("application/json")) {
        return send(res, 415, { error: "Use application/json." });
      }
      const body = req.method === "POST" ? await readJson(req) : {};
      const result = await handleApi(deps, {
        method: req.method ?? "GET",
        pathname: url.pathname,
        headers: req.headers as Record<string, string | undefined>,
        body,
      });
      if (result.text !== undefined) return send(res, result.status, result.text, "text/markdown; charset=utf-8", result.filename);
      return send(res, result.status, result.body, undefined, result.filename);
    } catch (error) {
      const { status, body } = errorResponse(error);
      return send(res, status, body);
    }
  });
}
