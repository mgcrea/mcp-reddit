#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { serve } from "@hono/node-server";
import { localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/hono";
import {
  getOAuthProtectedResourceMetadataUrl,
  isInitializeRequest,
  oauthMetadataResponse,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  WebStandardStreamableHTTPServerTransport,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";

import { BUILD_INFO } from "#/build-info";
import { verifyPkceS256 } from "#/client/oauth";
import { fileTokenStore } from "#/client/tokens";
import { loadConfig } from "#/config";
import { RedditOAuthProvider } from "#/oauth-provider";
import { createServer } from "#/server";

/**
 * HTTP (Streamable HTTP) entrypoint. Two reasons to run this rather than the
 * stdio CLI:
 *
 * 1. Claude Code's **Authenticate button** only exists for HTTP-transport
 *    servers — OAuth in MCP is defined for HTTP transports, and a stdio server
 *    takes its credentials from the environment. Over stdio the equivalent is
 *    the reddit_auth_login tool.
 * 2. An HTTP server can be restarted underneath a live client, so `pnpm dev:http`
 *    gives an edit→reload loop without reloading the editor window.
 *
 * Register it with:
 *   claude mcp add --transport http reddit http://127.0.0.1:8725/mcp
 *
 * NOTE: the callback below must be registered verbatim as the redirect URI on
 * https://www.reddit.com/prefs/apps — Reddit matches it byte for byte.
 *
 * ## Why the authorization-server endpoints are hand-written
 *
 * SDK v1 shipped `mcpAuthRouter`, which mounted /authorize, /token, /register
 * and /revoke over an `OAuthServerProvider`. v2 dropped the authorization-server
 * role: it survives only in the frozen `@modelcontextprotocol/server-legacy`,
 * and only as an express `RequestHandler`, so it cannot be mounted here at all.
 * The four routes below are that router, reimplemented over the same provider —
 * which still holds all of the logic. The resource-server half (bearer checking
 * and the two discovery documents) is not hand-written: those come from
 * `@modelcontextprotocol/server` in their web-standard form.
 */

const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.REDDIT_DEBUG) console.error("[reddit-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[reddit-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[reddit-mcp]", ...args),
};

/**
 * Loopback only. `listen(port)` with no host binds 0.0.0.0 — every interface —
 * no matter what the log line says, which in two sibling servers in this
 * directory left a live session reachable from the whole LAN.
 */
const HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
/** Cap the body: an unbounded reader plus an open port is a one-request OOM. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SCOPES_SUPPORTED = ["identity", "read", "history", "mysubreddits"];

/** RFC 6749 error responses, shaped the way a client expects to parse them. */
const oauthErrorResponse = (err: unknown, fallbackStatus = 400): Response => {
  const isOAuth = err instanceof OAuthError;
  const code = isOAuth ? err.code : OAuthErrorCode.ServerError;
  const status = isOAuth ? fallbackStatus : 500;
  return Response.json(
    {
      error: code,
      error_description: err instanceof Error ? err.message : String(err),
    },
    { status },
  );
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const port = config.httpPort;
  const issuer = new URL(`http://${HOST}:${port}`);
  const store = fileTokenStore(config.tokenPath);
  const provider = new RedditOAuthProvider({ config, store, issuer, logger: stderrLogger });

  /**
   * The middleware order matters, so the stack is composed by hand rather than
   * taken from `createMcpHonoApp`: that helper installs its own JSON body parser
   * ahead of anything registered afterwards, which would buffer and parse a
   * hostile body before the size gate below ever saw it. The two validation
   * middlewares below are the same ones it would have installed — the adapter
   * exports them separately for exactly this reason.
   */
  const app = new Hono();

  /** Reject an oversized body before anything reads, buffers, or parses it. */
  app.use(async (c, next) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) {
      return Response.json({ error: "payload_too_large", limit: MAX_BODY_BYTES }, { status: 413 });
    }
    return next();
  });

  // DNS-rebinding and cross-site defence for a loopback bind.
  app.use(localhostHostValidation());
  app.use(localhostOriginValidation());

  /** RFC 8414 metadata for the authorization server, which is this process. */
  const oauthMetadata: OAuthMetadata = {
    issuer: issuer.toString(),
    authorization_endpoint: new URL("/authorize", issuer).toString(),
    token_endpoint: new URL("/token", issuer).toString(),
    registration_endpoint: new URL("/register", issuer).toString(),
    revocation_endpoint: new URL("/revoke", issuer).toString(),
    scopes_supported: SCOPES_SUPPORTED,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };

  // Both discovery documents, straight from the SDK's web-standard helper.
  app.get("/.well-known/*", (c) => {
    const res = oauthMetadataResponse(c.req.raw, {
      oauthMetadata,
      resourceServerUrl: new URL(MCP_PATH, issuer),
      scopesSupported: SCOPES_SUPPORTED,
      resourceName: "Reddit MCP",
    });
    return res ?? c.notFound();
  });

  app.get("/authorize", async (c) => {
    const q = c.req.query();
    const client = q.client_id ? provider.clientsStore.getClient(q.client_id) : undefined;
    // A bad client_id or redirect_uri must NOT be redirected back to — that is
    // an open redirector. Answer directly instead.
    if (!client)
      return oauthErrorResponse(new OAuthError(OAuthErrorCode.InvalidClient, "Unknown client_id."));
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      return oauthErrorResponse(
        new OAuthError(
          OAuthErrorCode.InvalidRedirectUri,
          "redirect_uri is not registered for this client.",
        ),
      );
    }
    if (q.response_type !== "code") {
      return c.redirect(`${q.redirect_uri}?error=unsupported_response_type`);
    }
    if (q.code_challenge_method !== "S256" || !q.code_challenge) {
      return c.redirect(
        `${q.redirect_uri}?error=invalid_request&error_description=${encodeURIComponent("PKCE S256 is required.")}`,
      );
    }
    const target = await provider.authorize(client, {
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      state: q.state,
      scopes: q.scope ? q.scope.split(" ") : undefined,
    });
    return c.redirect(target);
  });

  app.post("/token", async (c) => {
    try {
      const form = await c.req.parseBody();
      const get = (k: string): string | undefined =>
        typeof form[k] === "string" ? (form[k] as string) : undefined;

      const clientId = get("client_id");
      const client = clientId ? provider.clientsStore.getClient(clientId) : undefined;
      if (!client) throw new OAuthError(OAuthErrorCode.InvalidClient, "Unknown client_id.");

      const grantType = get("grant_type");
      if (grantType === "authorization_code") {
        const code = get("code");
        const verifier = get("code_verifier");
        if (!code) throw new OAuthError(OAuthErrorCode.InvalidRequest, "code is required.");
        if (!verifier)
          throw new OAuthError(OAuthErrorCode.InvalidRequest, "code_verifier is required.");
        // Verify PKCE before spending the code: challengeForAuthorizationCode
        // reads it without consuming, exchangeAuthorizationCode consumes it.
        const challenge = await provider.challengeForAuthorizationCode(client, code);
        if (!verifyPkceS256(verifier, challenge)) {
          throw new OAuthError(OAuthErrorCode.InvalidGrant, "PKCE verification failed.");
        }
        return Response.json(await provider.exchangeAuthorizationCode(client, code));
      }

      if (grantType === "refresh_token") {
        const refreshToken = get("refresh_token");
        if (!refreshToken)
          throw new OAuthError(OAuthErrorCode.InvalidRequest, "refresh_token is required.");
        const scope = get("scope");
        return Response.json(
          await provider.exchangeRefreshToken(
            client,
            refreshToken,
            scope ? scope.split(" ") : undefined,
          ),
        );
      }

      throw new OAuthError(
        OAuthErrorCode.UnsupportedGrantType,
        `Unsupported grant_type: ${grantType ?? "(missing)"}`,
      );
    } catch (err) {
      if (!(err instanceof OAuthError)) stderrLogger.error("token endpoint failed", err);
      return oauthErrorResponse(err);
    }
  });

  // Dynamic client registration. Accepts anything, because this server is
  // loopback-only and every token it issues is scoped to the single Reddit
  // account whose refresh token is on this machine.
  app.post("/register", async (c) => {
    try {
      const body = (await c.req.json()) as { redirect_uris?: unknown };
      if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
        throw new OAuthError(
          OAuthErrorCode.InvalidClientMetadata,
          "redirect_uris is required and must be a non-empty array.",
        );
      }
      const registered = provider.clientsStore.registerClient(
        body as Parameters<typeof provider.clientsStore.registerClient>[0],
      );
      return Response.json(registered, { status: 201 });
    } catch (err) {
      if (!(err instanceof OAuthError)) stderrLogger.error("register endpoint failed", err);
      return oauthErrorResponse(err);
    }
  });

  // Tokens live in this process only, so revocation is best-effort and always
  // succeeds — RFC 7009 requires 200 even for an unknown token.
  app.post("/revoke", () => new Response(null, { status: 200 }));

  // Reddit's leg of the flow lands here, then bounces back to the MCP client.
  app.get("/oauth/callback", async (c) => {
    const q = c.req.query();
    try {
      const target = await provider.completeRedditCallback({
        ...(q.code === undefined ? {} : { code: q.code }),
        ...(q.state === undefined ? {} : { state: q.state }),
        ...(q.error === undefined ? {} : { error: q.error }),
      });
      return c.redirect(target);
    } catch (err) {
      stderrLogger.error("oauth callback failed", err);
      return c.text(err instanceof Error ? err.message : String(err), 400);
    }
  });

  // One MCP session per `initialize`, keyed by the SDK-issued session id, each
  // with its own McpServer. On reconnect after a watch restart the client
  // re-initializes, transparently creating a new session.
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  // resourceMetadataUrl puts the discovery pointer in the 401's WWW-Authenticate
  // header, which is what lets a client find the authorization server without
  // having to guess the well-known path.
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_PATH, issuer)),
  });

  app.all(MCP_PATH, async (c) => {
    // The gate resolves either to the verified AuthInfo or to a ready-made
    // challenge Response — a 401 for an invalid token, 403 for a missing scope.
    const auth = await bearer(c.req.raw);
    if (auth instanceof Response) return auth;

    try {
      const sessionId = c.req.header("mcp-session-id");
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport && c.req.method === "POST") {
        // Peek at the body to decide whether this is a fresh session. The
        // request is rebuilt below because the body stream is single-use.
        const raw = await c.req.raw
          .clone()
          .json()
          .catch(() => undefined);
        if (isInitializeRequest(raw)) {
          const created = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, created);
            },
          });
          // eslint-disable-next-line unicorn/prefer-add-event-listener -- SDK transport API
          created.onclose = () => {
            if (created.sessionId) transports.delete(created.sessionId);
          };
          const { server } = createServer({ config, logger: stderrLogger, store });
          await server.connect(created);
          transport = created;
        }
      }

      if (!transport) {
        return Response.json(
          {
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid session; send an initialize request first." },
            id: null,
          },
          { status: 400 },
        );
      }

      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      stderrLogger.error("request failed", err);
      return c.text("Internal error", 500);
    }
  });

  const server = serve({ fetch: app.fetch, hostname: HOST, port }, () => {
    stderrLogger.warn(`reddit-mcp HTTP listening on http://${HOST}:${port}${MCP_PATH}`);
    stderrLogger.warn(`  register this redirect URI on https://www.reddit.com/prefs/apps:`);
    stderrLogger.warn(`    ${provider.redditRedirectUri}`);
    stderrLogger.warn(
      `  then: claude mcp add --transport http reddit http://${HOST}:${port}${MCP_PATH}`,
    );
  });

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error("[reddit-mcp] fatal:", err);
  process.exit(1);
});
