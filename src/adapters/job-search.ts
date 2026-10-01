import { DETAIL_URL, SEARCH_URL, extractDivContent, jobageToTPR, parseJobCards, parseJobDetail, workTypeFlag, type JobCard } from "../../vendor/ai-job-search/linkedin-search/helpers.ts";
import { htmlToText } from "./html.ts";
import type { JobPageSnapshot } from "./job-link.ts";

/**
 * Job search over LinkedIn's public jobs-guest endpoints, using the parsers from
 * MadsLorentzen/ai-job-search (vendored, MIT). Read-only and low volume: one page
 * per search. LinkedIn's terms forbid automated access at scale, and this host
 * never submits applications there.
 */

export interface SearchParams {
  query: string;
  location: string;
  jobage?: number;
  remote?: "remote" | "hybrid" | "onsite" | "";
  limit?: number;
}

export type { JobCard };

export function searchUrl(params: SearchParams, page = 1): string {
  const q = new URLSearchParams();
  if (params.query) q.set("keywords", params.query);
  q.set("location", params.location || "Remote");
  const tpr = params.jobage ? jobageToTPR(params.jobage) : null;
  if (tpr) q.set("f_TPR", tpr);
  const wt = workTypeFlag(params.remote || undefined);
  if (wt) q.set("f_WT", wt);
  q.set("start", String((page - 1) * 10));
  return `${SEARCH_URL}?${q.toString()}`;
}

export async function searchJobs(params: SearchParams, fetchImpl: typeof fetch = fetch): Promise<JobCard[]> {
  const response = await fetchImpl(searchUrl(params), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; apply2interview/0.1)", Accept: "text/html", "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`La búsqueda devolvió HTTP ${response.status}.`);
  const cards = parseJobCards(await response.text());
  return cards.slice(0, Math.max(1, Math.min(params.limit ?? 25, 25)));
}

/** linkedin.com/jobs/view/<slug>-<id> -> numeric id, else null. */
export function linkedInJobId(url: string): string | null {
  const m = /linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i.exec(url) ?? /linkedin\.com\/.*[?&]currentJobId=(\d{6,})/i.exec(url);
  return m ? m[1] : null;
}

export function linkedInDetailUrl(id: string): string {
  return `${DETAIL_URL}/${id}`;
}

/** A LinkedIn guest detail page as a JD snapshot. Returns null when it has no description. */
export function snapshotFromLinkedInDetail(html: string, id: string, meta: { url: string; finalUrl: string; status: number; fetchedAt: string }): JobPageSnapshot | null {
  const job = parseJobDetail(html, id);
  // The upstream parser collapses whitespace; keep lines and bullets so requirements stay separate.
  const markup = extractDivContent(html, "show-more-less-html__markup") ?? extractDivContent(html, "description__text");
  const text = markup ? htmlToText(markup) : (job.description ?? "");
  if (text.length < 200) return null;
  return {
    url: meta.url,
    final_url: meta.finalUrl,
    http_status: meta.status,
    fetched_at: meta.fetchedAt,
    content_type: "text/html",
    page_title: job.title,
    extraction: "json_ld",
    text,
    json_ld: { title: job.title, company: job.company ?? undefined, location: job.location ?? undefined, employment_type: job.employmentType ?? undefined },
  };
}
