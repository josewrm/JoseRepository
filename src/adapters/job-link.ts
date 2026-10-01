import { htmlToText, jobPostingJsonLd, pageTitle } from "./html.ts";

/**
 * Job-link adapter. Fetches a PUBLIC job page only: no cookies, no login,
 * no credentials. Any sign of a login wall, block, or empty page is a
 * failure that the agent turns into a Request. It never invents a JD.
 */

export type FetchFailureReason = "invalid_url" | "network_error" | "login_wall" | "blocked" | "not_html" | "empty";

export interface JobPageSnapshot {
  url: string;
  final_url: string;
  http_status: number;
  fetched_at: string;
  content_type: string;
  page_title: string | null;
  extraction: "json_ld" | "html_text" | "human_supplied";
  text: string;
  json_ld: {
    title?: string;
    company?: string;
    location?: string;
    employment_type?: string;
    date_posted?: string;
    remote?: boolean;
  } | null;
}

export type FetchOutcome =
  | { ok: true; snapshot: JobPageSnapshot }
  | { ok: false; reason: FetchFailureReason; detail: string; http_status?: number; final_url?: string };

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  minTextLength?: number;
}

const LOGIN_PATH = /(\/|\b)(login|log-in|signin|sign-in|authwall|checkpoint|sso|auth\/|account\/login|uas\/login)/i;
const LOGIN_TEXT = [
  "sign in to", "log in to", "login to view", "sign in or join", "join now to see", "create an account to",
  "please log in", "you must be logged in", "inicia sesión", "iniciar sesión para", "melde dich an",
  "anmelden, um", "connectez-vous", "se connecter pour", "faça login", "accedi per",
];
const BLOCK_TEXT = ["are you a robot", "captcha", "access denied", "unusual traffic", "enable javascript to"];

export function validateJobUrl(raw: string): { ok: true; url: URL } | { ok: false; detail: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, detail: "job_url is not a valid URL." };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { ok: false, detail: "Only http and https job links are fetched." };
  if (url.username || url.password) return { ok: false, detail: "Job links with embedded credentials are rejected." };
  return { ok: true, url };
}

export async function fetchJobPage(rawUrl: string, options: FetchOptions = {}): Promise<FetchOutcome> {
  const checked = validateJobUrl(rawUrl);
  if (!checked.ok) return { ok: false, reason: "invalid_url", detail: checked.detail };
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const minText = options.minTextLength ?? 300;

  let response: Response;
  try {
    response = await fetchImpl(checked.url.href, {
      redirect: "follow",
      credentials: "omit",
      headers: {
        "User-Agent": "Apply2Interview/0.1 (+public job description reader)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en;q=0.9,*;q=0.5",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    return { ok: false, reason: "network_error", detail: `Fetch failed: ${(error as Error).message}` };
  }

  const finalUrl = response.url || checked.url.href;
  const status = response.status;
  if ([401, 403, 407, 999].includes(status)) {
    return { ok: false, reason: "login_wall", detail: `The job page answered HTTP ${status} (authentication or bot wall).`, http_status: status, final_url: finalUrl };
  }
  if (status === 429 || status >= 500) {
    return { ok: false, reason: "blocked", detail: `The job page answered HTTP ${status}.`, http_status: status, final_url: finalUrl };
  }
  if (status >= 400) {
    return { ok: false, reason: "empty", detail: `The job page answered HTTP ${status}; no job description is available.`, http_status: status, final_url: finalUrl };
  }
  if (finalUrl !== checked.url.href && LOGIN_PATH.test(new URL(finalUrl).pathname)) {
    return { ok: false, reason: "login_wall", detail: `The job link redirected to a login page (${new URL(finalUrl).pathname}).`, http_status: status, final_url: finalUrl };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
    return { ok: false, reason: "not_html", detail: `The job link returned ${contentType}, not a web page.`, http_status: status, final_url: finalUrl };
  }

  const html = await response.text();
  return snapshotFromHtml(html, { url: checked.url.href, finalUrl, status, contentType, fetchedAt: now().toISOString(), minText });
}

export function snapshotFromHtml(
  html: string,
  meta: { url: string; finalUrl: string; status: number; contentType: string; fetchedAt: string; minText?: number },
): FetchOutcome {
  const minText = meta.minText ?? 300;
  const ld = jobPostingJsonLd(html);
  const bodyText = htmlToText(html);
  let text = bodyText;
  let extraction: JobPageSnapshot["extraction"] = "html_text";
  if (ld?.description) {
    const ldText = htmlToText(String(ld.description));
    if (ldText.length >= minText / 2) {
      text = ldText;
      extraction = "json_ld";
    }
  }
  const lower = text.toLowerCase();
  if (BLOCK_TEXT.some((marker) => lower.includes(marker)) && text.length < 2000) {
    return { ok: false, reason: "blocked", detail: "The page shows a bot or JavaScript wall instead of a job description.", http_status: meta.status, final_url: meta.finalUrl };
  }
  if (LOGIN_TEXT.some((marker) => lower.includes(marker)) && text.length < 1500 && extraction !== "json_ld") {
    return { ok: false, reason: "login_wall", detail: "The page asks to sign in before showing the job description.", http_status: meta.status, final_url: meta.finalUrl };
  }
  if (text.length < minText) {
    return { ok: false, reason: "empty", detail: `The page has ${text.length} characters of readable text; no usable job description.`, http_status: meta.status, final_url: meta.finalUrl };
  }
  return {
    ok: true,
    snapshot: {
      url: meta.url,
      final_url: meta.finalUrl,
      http_status: meta.status,
      fetched_at: meta.fetchedAt,
      content_type: meta.contentType,
      page_title: pageTitle(html),
      extraction,
      text,
      json_ld: ld ? jsonLdSummary(ld) : null,
    },
  };
}

/** Snapshot for a JD the HumanWorker pasted in answer to a Request. */
export function snapshotFromHumanText(text: string, url: string, at: string): JobPageSnapshot {
  return {
    url,
    final_url: url,
    http_status: 0,
    fetched_at: at,
    content_type: "text/plain",
    page_title: null,
    extraction: "human_supplied",
    text: text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n"),
    json_ld: null,
  };
}

function jsonLdSummary(ld: Record<string, any>): NonNullable<JobPageSnapshot["json_ld"]> {
  const org = ld.hiringOrganization;
  const company = typeof org === "string" ? org : org?.name;
  const loc = Array.isArray(ld.jobLocation) ? ld.jobLocation[0] : ld.jobLocation;
  const address = loc?.address;
  const location = typeof address === "string"
    ? address
    : [address?.addressLocality, address?.addressRegion, address?.addressCountry?.name ?? address?.addressCountry]
        .filter((part) => typeof part === "string" && part)
        .join(", ") || undefined;
  return {
    title: ld.title ? String(ld.title) : undefined,
    company: company ? String(company) : undefined,
    location,
    employment_type: Array.isArray(ld.employmentType) ? ld.employmentType.join(", ") : ld.employmentType,
    date_posted: ld.datePosted,
    remote: ld.jobLocationType === "TELECOMMUTE" ? true : undefined,
  };
}
