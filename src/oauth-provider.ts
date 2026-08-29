import { randomBytes } from "node:crypto";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";

import type { Logger } from "./client/auth.js";
import { postToken } from "./client/auth.js";
import { buildAuthorizeUrl, createPkcePair, statesMatch } from "./client/oauth.js";
import { TOKEN_FILE_VERSION, type TokenStore } from "./client/tokens.js";
import { effectiveScopes, type Config } from "./config.js";

/**
 * Why this exists rather than the SDK's ProxyOAuthServerProvider.
 *
 * The proxy provider forwards the *client's* redirect_uri to the upstream
 * authorization server. Reddit matches redirect_uri byte for byte against the
 * single value registered on the app preferences page, and Claude Code picks its
 * loopback callback port dynamically — so the proxy's redirect is rejected every
 * time. Reddit also has no dynamic client registration to fall back on.
 *
 * So this server is its own authorization server, and hides the Reddit leg:
 *
 *   Claude Code → /authorize → (browser) → Reddit consent
 *                                              ↓
 *   Claude Code ← /oauth/callback?code=ours ← our fixed registered callback
 *   Claude Code → /token  → our token, mapped to the stored Reddit refresh token
 *
 * The Reddit refresh token never leaves this process; what Claude Code holds is
 * an opaque local token that only means something here.
 */

const opaque = (): string => randomBytes(32).toString("base64url");

/** How long an authorization code stays usable. OAuth 2.1 says ten minutes at most. */
const CODE_TTL_MS = 10 * 60 * 1000;

type PendingAuth = {
  /** Where to send the browser once Reddit comes back. */
  clientRedirectUri: string;
  clientState: string | undefined;
  /** The MCP client's PKCE challenge, which we verify ourselves. */
  clientChallenge: string;
  /** Our own PKCE verifier for the Reddit leg. */
  redditVerifier: string;
  /** Our own state on the Reddit leg, so a stray callback is rejected. */
  redditState: string;
  clientId: string;
  createdAt: number;
};

type IssuedCode = {
  clientId: string;
  clientChallenge: string;
  redirectUri: string;
  scopes: string[];
  createdAt: number;
};

type IssuedToken = {
  clientId: string;
  scopes: string[];
  expiresAt: number;
};

export type RedditOAuthProviderOptions = {
  config: Config;
  store: TokenStore;
  /** Absolute base of this server, e.g. http://127.0.0.1:8725 */
  issuer: URL;
  fetch?: typeof fetch;
  logger?: Logger;
};

export class RedditOAuthProvider implements OAuthServerProvider {
  private readonly config: Config;
  private readonly store: TokenStore;
  private readonly issuer: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  /** Keyed by our Reddit-leg state, so the callback can find its pending auth. */
  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly access = new Map<string, IssuedToken>();
  private readonly refresh = new Map<string, { clientId: string; scopes: string[] }>();

  constructor(opts: RedditOAuthProviderOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.issuer = opts.issuer;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  /** Our own fixed callback — this is the URI that must be registered on Reddit. */
  get redditRedirectUri(): string {
    return new URL("/oauth/callback", this.issuer).toString();
  }

  /**
   * Accepts any dynamic registration and hands back one fixed local client.
   * Safe because this server is loopback-only and every issued token is scoped
   * to the single Reddit account whose refresh token is on this machine — there
   * is no cross-tenant boundary for a registration to breach.
   */
  get clientsStore(): OAuthRegisteredClientsStore {
    const clients = this.registeredClients;
    return {
      getClient: (clientId) => clients.get(clientId),
      registerClient: (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: `local-${opaque().slice(0, 16)}`,
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        clients.set(full.client_id, full);
        return full;
      },
    };
  }

  private readonly registeredClients = new Map<string, OAuthClientInformationFull>();

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (!this.config.clientId) {
      res.redirect(
        `${params.redirectUri}?error=server_error&error_description=${encodeURIComponent(
          "REDDIT_CLIENT_ID is not set on the MCP server",
        )}`,
      );
      return;
    }

    const { verifier, challenge } = createPkcePair();
    const redditState = opaque();
    this.pending.set(redditState, {
      clientRedirectUri: params.redirectUri,
      clientState: params.state,
      clientChallenge: params.codeChallenge,
      redditVerifier: verifier,
      redditState,
      clientId: client.client_id,
      createdAt: Date.now(),
    });
    this.sweep();

    res.redirect(
      buildAuthorizeUrl({
        clientId: this.config.clientId,
        // Our own fixed callback, not the client's — this is the whole point.
        redirectUri: this.redditRedirectUri,
        scopes: effectiveScopes(this.config),
        state: redditState,
        challenge,
      }),
    );
  }

  /**
   * Called by the /oauth/callback route once Reddit redirects back. Exchanges
   * Reddit's code for a refresh token, persists it, and returns where to send
   * the browser next.
   */
  async completeRedditCallback(query: {
    code?: string;
    state?: string;
    error?: string;
  }): Promise<string> {
    const state = query.state ?? "";
    const entry = [...this.pending.values()].find((p) => statesMatch(p.redditState, state));
    if (!entry) {
      throw new Error(
        "Unknown or expired OAuth state — this callback did not come from a login this server started.",
      );
    }
    this.pending.delete(entry.redditState);

    const back = (params: Record<string, string>): string => {
      const url = new URL(entry.clientRedirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (entry.clientState !== undefined) url.searchParams.set("state", entry.clientState);
      return url.toString();
    };

    if (query.error || !query.code) {
      return back({ error: "access_denied", error_description: query.error ?? "no code returned" });
    }

    const tokens = await postToken(
      { ...this.config, redirectUri: this.redditRedirectUri },
      new URLSearchParams({
        grant_type: "authorization_code",
        code: query.code,
        redirect_uri: this.redditRedirectUri,
        code_verifier: entry.redditVerifier,
      }),
      this.fetchImpl,
    );
    if (!tokens.refresh_token) {
      return back({
        error: "server_error",
        error_description: "Reddit returned no refresh token (is duration=permanent set?)",
      });
    }

    const scopes = tokens.scope
      ? tokens.scope.split(/[\s,]+/).filter(Boolean)
      : effectiveScopes(this.config);
    this.store.write({
      version: TOKEN_FILE_VERSION,
      refreshToken: tokens.refresh_token,
      scopes,
      obtainedAt: Math.floor(Date.now() / 1000),
    });
    this.logger?.warn?.("reddit account linked via HTTP OAuth flow");

    const code = opaque();
    this.codes.set(code, {
      clientId: entry.clientId,
      clientChallenge: entry.clientChallenge,
      redirectUri: entry.clientRedirectUri,
      scopes,
      createdAt: Date.now(),
    });
    return back({ code });
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Unknown or expired authorization code.");
    return entry.clientChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Unknown or expired authorization code.");
    // Single use: an authorization code replayed is an authorization code stolen.
    this.codes.delete(authorizationCode);
    if (entry.clientId !== client.client_id)
      throw new Error("Authorization code was issued to a different client.");
    if (Date.now() - entry.createdAt > CODE_TTL_MS)
      throw new Error("Authorization code has expired.");
    return this.issue(client.client_id, entry.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const entry = this.refresh.get(refreshToken);
    if (!entry) throw new Error("Unknown refresh token.");
    this.refresh.delete(refreshToken);
    return this.issue(client.client_id, scopes ?? entry.scopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.access.get(token);
    if (!entry) throw new Error("Invalid access token.");
    if (entry.expiresAt <= Date.now()) {
      this.access.delete(token);
      throw new Error("Access token has expired.");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
    };
  }

  private issue(clientId: string, scopes: string[]): OAuthTokens {
    const accessToken = opaque();
    const refreshToken = opaque();
    const ttlSeconds = 3600;
    this.access.set(accessToken, { clientId, scopes, expiresAt: Date.now() + ttlSeconds * 1000 });
    this.refresh.set(refreshToken, { clientId, scopes });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ttlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  /** Drop abandoned logins, so a browser closed mid-flow does not leak memory. */
  private sweep(): void {
    const cutoff = Date.now() - CODE_TTL_MS;
    for (const [key, entry] of this.pending) if (entry.createdAt < cutoff) this.pending.delete(key);
    for (const [key, entry] of this.codes) if (entry.createdAt < cutoff) this.codes.delete(key);
  }
}
