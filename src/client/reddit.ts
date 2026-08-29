import type { AuthContext, Logger, TokenProvider } from "./auth.js";
import { RedditActionError, RedditApiError } from "./errors.js";
import { isRecord } from "./shape.js";

export type Query = Record<string, string | number | boolean | undefined>;

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

export type RateLimit = { used?: number; remaining?: number; resetSeconds?: number };

/**
 * Reddit reports its budget on every response, not only on a 429. Keeping the
 * last snapshot means the 429 message can quote the actual window instead of
 * saying "rate limited" and leaving the caller to guess how long to wait.
 */
export const readRateLimit = (res: Response): RateLimit => {
  const n = (name: string): number | undefined => {
    const raw = res.headers.get(name);
    if (raw === null) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    used: n("x-ratelimit-used"),
    remaining: n("x-ratelimit-remaining"),
    resetSeconds: n("x-ratelimit-reset"),
  };
};

/**
 * Collapse a concrete path to the shape Reddit documents its limits against, so
 * `/r/rust/comments/abc` and `/r/go/comments/def` share one bucket rather than
 * leaking a new entry per thread.
 */
export const endpointKey = (method: string, path: string): string =>
  `${method} ${path
    .replace(/\/r\/[^/]+/g, "/r/:sub")
    .replace(
      /\/(?:comments|user)\/[^/]+/g,
      (m) => `${m.split("/")[1] ? `/${m.split("/")[1]}` : ""}/:id`,
    )
    .replace(/\?.*$/, "")}`;

export type RedditClientOptions = {
  baseUrl: string;
  tokenProvider: TokenProvider;
  maxRetries: number;
  userAgent: string;
  fetch?: typeof fetch;
  logger?: Logger;
};

export class RedditClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenProvider;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly rateLimits = new Map<string, RateLimit>();

  constructor(opts: RedditClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokenProvider;
    this.maxRetries = opts.maxRetries;
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  /** The last rate-limit snapshot per endpoint shape, for reddit_rate_limit_status. */
  rateLimitSnapshot(): Record<string, RateLimit> {
    return Object.fromEntries(this.rateLimits);
  }

  async get<T = unknown>(path: string, query?: Query, auth: AuthContext = "app"): Promise<T> {
    return this.request<T>("GET", path, { query, auth });
  }

  /**
   * Reddit's write endpoints take form encoding, not JSON, and answer HTTP 200
   * even when the action failed — the real result is in `json.errors`. Both are
   * handled here so no tool has to remember.
   */
  async post<T = unknown>(path: string, form: Query, auth: AuthContext = "user"): Promise<T> {
    return this.request<T>("POST", path, { form, auth });
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; form?: Query; auth?: AuthContext } = {},
  ): Promise<T> {
    const auth = opts.auth ?? "app";
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // Reddit's JSON is wrapped for the old web UI unless you ask it not to be.
    if (method === "GET") url.searchParams.set("raw_json", "1");

    const body =
      opts.form === undefined
        ? undefined
        : new URLSearchParams(
            Object.entries(opts.form)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, String(v)]),
          ).toString();

    let attempt = 0;
    for (;;) {
      const token = await this.tokens.getToken(auth);
      this.logger?.debug?.(`${method} ${url.pathname} (auth=${auth}, attempt ${attempt + 1})`);

      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });

      const limit = readRateLimit(res);
      if (limit.remaining !== undefined || limit.used !== undefined) {
        this.rateLimits.set(endpointKey(method, url.pathname), limit);
      }

      if (res.status === 401 && attempt < this.maxRetries) {
        this.logger?.warn?.("HTTP 401 — reminting the token and retrying");
        this.tokens.invalidate(auth);
        attempt += 1;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`HTTP ${res.status} — retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
        continue;
      }

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }

      if (!res.ok)
        throw new RedditApiError(this.errorMessage(res, method, path, limit), {
          status: res.status,
          errors: parsed ?? text.slice(0, 500),
          rateLimit: limit,
        });

      assertNoActionError(parsed, `${method} ${path}`);
      return parsed as T;
    }
  }

  private errorMessage(res: Response, method: string, path: string, limit: RateLimit): string {
    const base = `Reddit API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}`.trim();
    if (res.status === 401) {
      return (
        `${base} — the token was rejected. If this was a user-scoped call, the login may have ` +
        `been revoked at https://www.reddit.com/prefs/apps; run reddit_auth_login again.`
      );
    }
    if (res.status === 403) {
      return (
        `${base} — authenticated, but not allowed. Usually a private or quarantined subreddit, ` +
        `or a scope the login never asked for (check reddit_auth_status).`
      );
    }
    if (res.status === 404) {
      return `${base} — no such subreddit, user or thread. Reddit also returns 404 for banned subreddits.`;
    }
    if (res.status === 429) {
      const window =
        limit.remaining !== undefined
          ? ` (${limit.remaining} of ${(limit.remaining ?? 0) + (limit.used ?? 0)} left` +
            (limit.resetSeconds !== undefined ? `, resets in ${limit.resetSeconds}s` : "") +
            `)`
          : "";
      return (
        `${base} — rate limited${window}. Reddit allows about 100 requests per minute per ` +
        `client; wait for the window, or lower \`limit\`.`
      );
    }
    return base;
  }
}

/**
 * Reddit's `/api/*` endpoints answer HTTP 200 with `{json: {errors: [[code,
 * message, field]]}}` when the action failed, so a 2xx is not success. Left
 * unchecked, a rejected submission looks like a successful one.
 */
export const assertNoActionError = (parsed: unknown, what: string): void => {
  if (!isRecord(parsed) || !isRecord(parsed.json)) return;
  const errors = parsed.json.errors;
  if (!Array.isArray(errors) || errors.length === 0) return;
  const rendered = errors
    .map((e) => (Array.isArray(e) ? e.filter(Boolean).join(": ") : String(e)))
    .join("; ");
  throw new RedditActionError(`${what} was rejected by Reddit: ${rendered}`, errors);
};
