#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

import { BUILD_INFO } from "./build-info.js";
import { fileTokenStore } from "./client/tokens.js";
import { loadConfig } from "./config.js";
import { RedditOAuthProvider } from "./oauth-provider.js";
import { createServer } from "./server.js";

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

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const port = config.httpPort;
  const issuer = new URL(`http://${HOST}:${port}`);
  const store = fileTokenStore(config.tokenPath);

  const provider = new RedditOAuthProvider({ config, store, issuer, logger: stderrLogger });
  const app = express();
  app.disable("x-powered-by");

  /**
   * Defence in depth against DNS rebinding. The transport still accepts
   * `allowedHosts` / `enableDnsRebindingProtection`, but those are deprecated in
   * SDK 1.30 in favour of exactly this — external middleware — so the check
   * lives here where it will not quietly stop working.
   */
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (host !== undefined && !allowedHosts.has(host)) {
      res.status(421).json({ error: "invalid_host", host });
      return;
    }
    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      !origin.startsWith(`http://${HOST}:`) &&
      !origin.startsWith("http://localhost:")
    ) {
      res.status(403).json({ error: "invalid_origin", origin });
      return;
    }
    next();
  });

  // Must be installed at the application root: it serves /authorize, /token,
  // /register and the .well-known metadata Claude Code discovers.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: new URL(MCP_PATH, issuer),
      scopesSupported: ["identity", "read", "history", "mysubreddits"],
      resourceName: "Reddit MCP",
    }),
  );

  // Reddit's leg of the flow lands here, then bounces back to the MCP client.
  app.get("/oauth/callback", (req, res) => {
    void (async () => {
      try {
        const target = await provider.completeRedditCallback({
          ...(typeof req.query.code === "string" ? { code: req.query.code } : {}),
          ...(typeof req.query.state === "string" ? { state: req.query.state } : {}),
          ...(typeof req.query.error === "string" ? { error: req.query.error } : {}),
        });
        res.redirect(target);
      } catch (err) {
        stderrLogger.error("oauth callback failed", err);
        res
          .status(400)
          .type("text/plain")
          .send(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  // One MCP session per `initialize`, keyed by the SDK-issued session id, each
  // with its own McpServer. On reconnect after a watch restart the client
  // re-initializes, transparently creating a new session.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // resourceMetadataUrl puts the discovery pointer in the 401's WWW-Authenticate
  // header, which is what lets a client find the authorization server without
  // having to guess the well-known path.
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_PATH, issuer)),
  });

  app.use(MCP_PATH, bearer, express.json({ limit: MAX_BODY_BYTES }), (req, res) => {
    void (async () => {
      try {
        const sessionId = req.headers["mcp-session-id"];
        let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

        if (!transport && req.method === "POST" && isInitializeRequest(req.body)) {
          const created = new StreamableHTTPServerTransport({
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

        if (!transport) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid session; send an initialize request first." },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        stderrLogger.error("request failed", err);
        if (!res.headersSent) res.status(500).type("text/plain").send("Internal error");
      }
    })();
  });

  const httpServer = app.listen(port, HOST, () => {
    stderrLogger.warn(`reddit-mcp HTTP listening on http://${HOST}:${port}${MCP_PATH}`);
    stderrLogger.warn(`  register this redirect URI on https://www.reddit.com/prefs/apps:`);
    stderrLogger.warn(`    ${provider.redditRedirectUri}`);
    stderrLogger.warn(
      `  then: claude mcp add --transport http reddit http://${HOST}:${port}${MCP_PATH}`,
    );
  });
  // Slow-loris protection: a client that opens a socket and never finishes its
  // headers should not hold a slot indefinitely.
  httpServer.headersTimeout = 20_000;
  httpServer.requestTimeout = 60_000;

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error("[reddit-mcp] fatal:", err);
  process.exit(1);
});
