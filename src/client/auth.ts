import type { Config } from "../config.js";
import { effectiveScopes, TOKEN_URL } from "../config.js";
import { UserContextRequiredError } from "./errors.js";
import type { TokenStore } from "./tokens.js";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

/** Which credential a request runs under. `user` fails when nobody has logged in. */
export type AuthContext = "app" | "user";

export type TokenProvider = {
  getToken(context: AuthContext): Promise<string>;
  /** Called by the client's retry loop on a 401, so an expired token is reminted once. */
  invalidate(context: AuthContext): void;
  /** True once a refresh token exists on disk. Drives tool registration. */
  hasUser(): boolean;
  scopes(): string[];
};

/** For tests: one token for both contexts, no network and no files. */
export const staticTokenProvider = (token: string, hasUser = true): TokenProvider => ({
  getToken: async () => token,
  invalidate: () => {},
  hasUser: () => hasUser,
  scopes: () => [],
});

export type TokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
};

/**
 * Reddit authenticates the *client* with HTTP Basic on every token request,
 * including the anonymous one. An "installed app" has no secret, and the empty
 * password after the colon is required — `client_id:` not `client_id`.
 */
export const basicAuth = (config: Config): string =>
  `Basic ${Buffer.from(`${config.clientId ?? ""}:${config.clientSecret ?? ""}`).toString("base64")}`;

export const postToken = async (
  config: Config,
  body: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> => {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(config),
      "Content-Type": "application/x-www-form-urlencoded",
      // Reddit throttles the token endpoint on User-Agent too, not just the API.
      "User-Agent": config.userAgent ?? "mcp-reddit",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await res.text();
  let parsed: TokenResponse;
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(
      `Reddit token endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok || parsed.error) {
    // 401 here is almost always the client id/secret pair, not the user — say so,
    // because the natural reading of "unauthorized" sends people to re-login.
    const hint =
      res.status === 401
        ? " — Reddit rejected the app credentials. Check REDDIT_CLIENT_ID, and that " +
          "REDDIT_CLIENT_SECRET is set for a web/script app and unset for an installed app."
        : "";
    throw new Error(
      `Reddit token request failed: HTTP ${res.status} ${parsed.error ?? ""}${hint}`.trim(),
    );
  }
  return parsed;
};

type CachedToken = { token: string; expiresAt: number };

export type CreateTokenProviderOptions = {
  config: Config;
  store: TokenStore;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => number;
};

/**
 * Two credentials behind one interface.
 *
 * `app` is the anonymous installed-client grant: it needs only a client id, and
 * it is what makes this server useful before anyone logs in — public subreddits,
 * posts, comments and search all work with it.
 *
 * `user` is the refresh token from reddit_auth_login. Subscriptions, saved
 * posts, the inbox and every write need it, and asking for it when it does not
 * exist is an error the caller can act on rather than a confusing 403.
 */
export const createTokenProvider = (opts: CreateTokenProviderOptions): TokenProvider => {
  const { config, store } = opts;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const cache = new Map<AuthContext, CachedToken>();

  const cacheFor = (context: AuthContext, res: TokenResponse): string => {
    const lifetime = (res.expires_in ?? 3600) * 1000;
    // Clamp the skew to half the real lifetime: a short-lived token must not be
    // treated as expired the moment it arrives.
    const skew = Math.min(config.refreshSkewSeconds * 1000, lifetime / 2);
    cache.set(context, { token: res.access_token, expiresAt: now() + lifetime - skew });
    return res.access_token;
  };

  const mintApp = async (): Promise<string> => {
    opts.logger?.debug?.("minting anonymous installed-client token");
    const res = await postToken(
      config,
      new URLSearchParams({
        grant_type: "https://oauth.reddit.com/grants/installed_client",
        device_id: config.deviceId,
      }),
      fetchImpl,
    );
    return cacheFor("app", res);
  };

  const mintUser = async (): Promise<string> => {
    const stored = store.read();
    if (!stored) throw new UserContextRequiredError("This tool");
    opts.logger?.debug?.("refreshing user token");
    const res = await postToken(
      config,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refreshToken }),
      fetchImpl,
    );
    // Reddit may rotate the refresh token; persist the new one or the next
    // refresh fails with a token that was silently retired.
    if (res.refresh_token && res.refresh_token !== stored.refreshToken) {
      store.write({ ...stored, refreshToken: res.refresh_token });
    }
    return cacheFor("user", res);
  };

  return {
    getToken: async (context) => {
      const hit = cache.get(context);
      if (hit && hit.expiresAt > now()) return hit.token;
      return context === "user" ? mintUser() : mintApp();
    },
    invalidate: (context) => cache.delete(context),
    hasUser: () => store.read() !== undefined,
    scopes: () => store.read()?.scopes ?? effectiveScopes(config),
  };
};
