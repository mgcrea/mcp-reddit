import { execFile } from "node:child_process";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildAuthorizeUrl, createPkcePair, runLoopbackLogin } from "#/client/oauth";
import { effectiveScopes, setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/** Best-effort browser open. A headless box just gets the URL back instead. */
const openBrowser = (url: string): void => {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {
    /* the URL is in the tool result either way */
  });
};

/**
 * Auth is exposed as tools rather than a CLI subcommand so the user never has to
 * leave the conversation: "log me into Reddit" opens the browser. Claude Code's
 * Authenticate button only exists for HTTP-transport servers (see src/http.ts);
 * over stdio, this is the equivalent.
 *
 * These are registered first and unconditionally, so an unconfigured server is
 * still a useful one rather than a connection that closes.
 */
export const registerAuthTools = (server: McpServer, ctx: ToolContext): void => {
  server.registerTool(
    "reddit_auth_status",
    {
      title: "Reddit: Auth Status",
      description:
        "Report what credentials this server has, which tools are therefore available, and — " +
        "when something is missing — exactly what to set or run to fix it. Call this first " +
        "whenever a tool you expected is not there: an absent tool usually means a missing " +
        "scope or login rather than a bug.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => ({
        configured: Boolean(ctx.config.clientId),
        signedIn: ctx.tokens.hasUser(),
        mode: ctx.tokens.hasUser() ? "user" : "anonymous (app-only)",
        writes: ctx.allowWrites ? "enabled" : "disabled",
        scopes: ctx.tokens.hasUser() ? ctx.tokens.scopes() : effectiveScopes(ctx.config),
        userAgent: ctx.config.userAgent ?? "(unset — Reddit will throttle this server)",
        setup: setupInstructions(ctx.config, ctx.tokens.hasUser()),
      })),
  );

  server.registerTool(
    "reddit_auth_login",
    {
      title: "Reddit: Auth Login",
      description:
        "Sign in to Reddit in a browser. Opens Reddit's consent page, catches the callback on " +
        "a loopback port and stores a refresh token, so this is a one-time step. Needed for " +
        "your subscriptions, saved posts and inbox, and for anything that writes — public " +
        "browsing and search already work without it.",
      inputSchema: {
        open: z
          .boolean()
          .default(true)
          .describe(
            "Open the browser automatically. Set false on a headless machine and use the " +
              "returned `authorize_url` yourself.",
          ),
      },
      // Not readOnly (it opens a browser and writes a token file), but deliberately
      // NOT gated behind allowWrites: logging in changes nothing on Reddit, and
      // gating it would leave a read-only install unable to see its own account.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ open }) =>
      wrap(async () => {
        const result = await runLoopbackLogin({
          config: ctx.config,
          store: ctx.store,
          ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
          ...(open ? { open: openBrowser } : {}),
        });
        return {
          signedIn: true,
          scopes: result.scopes,
          note: "Restart the MCP server to pick up the user-scoped tools.",
        };
      }),
  );

  server.registerTool(
    "reddit_auth_logout",
    {
      title: "Reddit: Auth Logout",
      description:
        "Forget the stored Reddit refresh token. Anonymous browsing keeps working; the " +
        "account-scoped tools stop. This does not revoke the app on Reddit's side — do that " +
        "at https://www.reddit.com/prefs/apps.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async () =>
      wrap(async () => {
        const had = ctx.tokens.hasUser();
        ctx.store.clear();
        ctx.tokens.invalidate("user");
        return { signedOut: had, note: had ? "Refresh token deleted." : "No login was stored." };
      }),
  );

  server.registerTool(
    "reddit_auth_url",
    {
      title: "Reddit: Auth URL",
      description:
        "Build the Reddit consent URL without starting the loopback listener. Use this when " +
        "the browser is on a different machine than the server, or to check which scopes a " +
        "login would request before running reddit_auth_login.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        if (!ctx.config.clientId) {
          return {
            error: "REDDIT_CLIENT_ID is not set.",
            setup: setupInstructions(ctx.config, false),
          };
        }
        const { challenge } = createPkcePair();
        return {
          // The state and verifier here are throwaway: this tool is for reading the
          // URL, and reddit_auth_login generates its own pair it can actually verify.
          note:
            "Informational only — this URL cannot complete a login. Run reddit_auth_login to " +
            "sign in, which generates its own PKCE pair and listens for the callback.",
          scopes: effectiveScopes(ctx.config),
          redirect_uri: ctx.config.redirectUri,
          authorize_url: buildAuthorizeUrl({
            clientId: ctx.config.clientId,
            redirectUri: ctx.config.redirectUri,
            scopes: effectiveScopes(ctx.config),
            state: "example",
            challenge,
          }),
        };
      }),
  );
};
