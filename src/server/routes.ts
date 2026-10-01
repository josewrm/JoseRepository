import { Apply2InterviewService, UserError } from "../app/service.ts";
import { HUMAN_ACTOR_ID } from "../app/participants.ts";
import { JarvisError, PROTOCOL_VERSION, type ProtocolRecord } from "../protocol/jarvis.ts";
import { TruthGuardError } from "../adapt/truth-guard.ts";
import { EmailGuardError } from "../email/drafter.ts";
import { buildEvidenceManifest } from "../export/evidence-pack.ts";

/**
 * Host API routes, independent of transport. The Node server (http.ts) and
 * the browser build (browser/main.ts) both call handleApi.
 */

export interface PackResult {
  location: string;
  files: Record<string, unknown>;
  manifest: ProtocolRecord;
  checks: { command: string; file: string; ok: boolean; output: string }[];
  validator: string;
}

export interface RouteDeps {
  service: Apply2InterviewService;
  exportPack: (workSessionId: string) => PackResult;
  onOutcome?: (workSessionId: string) => void;
}

export interface ApiRequest {
  method: string;
  pathname: string;
  headers: Record<string, string | undefined>;
  body: any;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Plain-text body (markdown download). */
  text?: string;
  filename?: string;
}

export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(typeof body === "string" ? body : JSON.stringify(body));
    this.status = status;
    this.body = body;
  }
}

export function errorResponse(error: unknown): ApiResponse {
  if (error instanceof HttpError) return { status: error.status, body: error.body };
  if (error instanceof UserError) return { status: error.status, body: { error: error.message } };
  if (error instanceof TruthGuardError) return { status: 422, body: { error: error.message, violations: error.violations } };
  if (error instanceof EmailGuardError) return { status: 422, body: { error: error.message } };
  if (error instanceof JarvisError) return { status: 409, body: { error: error.message, protocol_error: error.toProtocolError() } };
  console.error(error);
  return { status: 500, body: { error: "Internal error" } };
}

type Handler = (m: RegExpMatchArray, body: any) => Promise<ApiResponse | unknown> | ApiResponse | unknown;

export async function handleApi(deps: RouteDeps, req: ApiRequest): Promise<ApiResponse> {
  const { service } = deps;
  const routes: [string, RegExp, Handler][] = [
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
      deps.onOutcome?.(m[1]);
      return { outcome_report: report, view: service.view(m[1]) };
    }],
    ["POST", /^\/api\/sessions\/([\w-]+)\/export$/, (m) => {
      const pack = deps.exportPack(m[1]);
      return {
        dir: pack.location,
        files: Object.keys(pack.files),
        manifest: pack.manifest,
        validator: pack.validator,
        jarvis_cli: { total: pack.checks.length, passed: pack.checks.filter((c) => c.ok).length, failures: pack.checks.filter((c) => !c.ok) },
      };
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)\/export\.json$/, (m) => ({ status: 200, body: deps.exportPack(m[1]).files, filename: `${m[1]}-evidence-pack.json` })],
    ["GET", /^\/api\/sessions\/([\w-]+)\/cv\/accepted\.md$/, (m) => {
      const accepted = service.view(m[1]).artifacts.accepted_cv;
      if (!accepted) throw new HttpError(404, { error: "No accepted CV version yet." });
      return { status: 200, body: null, text: accepted.text, filename: `${m[1]}-cv-accepted.md` };
    }],
    ["GET", /^\/api\/sessions\/([\w-]+)\/cv\/patch\.json$/, (m) => {
      const patches = service.view(m[1]).artifacts.cv_patches;
      if (!patches.length) throw new HttpError(404, { error: "No CV patch." });
      return { status: 200, body: patches[patches.length - 1].patch, filename: `${m[1]}-cvs-best-version.json` };
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

  try {
    if (req.pathname.startsWith("/jarvis/")) {
      if (req.headers["jarvis-protocol-version"] !== PROTOCOL_VERSION) {
        return { status: 400, body: new JarvisError("missing_protocol_version", "headers.Jarvis-Protocol-Version", "Jarvis read operations require Jarvis-Protocol-Version.").toProtocolError() };
      }
      if (req.headers["jarvis-actor-id"] !== HUMAN_ACTOR_ID) {
        return { status: 400, body: new JarvisError("unauthorized_actor", "headers.Jarvis-Actor-Id", "Unknown reading Actor.").toProtocolError() };
      }
    }
    for (const [method, pattern, handler] of routes) {
      const match = req.pathname.match(pattern);
      if (!match || req.method !== method) continue;
      const result: any = await handler(match, req.body ?? {});
      if (result && typeof result === "object" && "status" in result && ("text" in result || "filename" in result)) return result as ApiResponse;
      return { status: 200, body: result };
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (error) {
    return errorResponse(error);
  }
}
