/** Minimal HTTP helper: timeouts, bounded retries for transient failures, explicit errors. */

export const USER_AGENT = "boundry-maintenance/0.1 (+https://github.com/rkendel1/boundry-maint)";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(url: string, status: number, message: string) {
    super(`${status} ${message} (${url})`);
    this.status = status;
    this.url = url;
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET a URL. Retries network errors, 429 and 5xx; never retries other 4xx. */
export async function get(url: string, opts: RequestOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      });
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const err = new HttpError(url, res.status, body.slice(0, 200) || res.statusText);
      if (res.status === 429 || res.status >= 500) {
        lastError = err;
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getJson<T = unknown>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await get(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  return (await res.json()) as T;
}

/** Run async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
