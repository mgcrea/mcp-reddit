import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { WritesDisabledError } from "#/client/errors";
import type { RedditClient } from "#/client/reddit";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

/** Reject traversal and absolute URLs, so this cannot be pointed off-host. */
export const assertSafePath = (path: string): void => {
  if (!path.startsWith("/"))
    throw new Error(`Path must start with "/", got ${JSON.stringify(path)}.`);
  if (path.includes("..")) throw new Error("Path may not contain `..`.");
  if (path.startsWith("//"))
    throw new Error("Path may not start with `//` — that is a protocol-relative URL.");
};

/**
 * The escape hatch: every API has more endpoints than anyone wraps, and without
 * this a missing one means a code change. Constrained so it cannot become a way
 * around the write gate — the method enum itself narrows to GET when writes are
 * off, and the handler checks again.
 */
export const registerRequestTool = (
  server: McpServer,
  client: RedditClient,
  ctx: ToolContext,
): void => {
  const allowWrites = ctx.allowWrites && ctx.tokens.hasUser();
  const methods = allowWrites ? (["GET", "POST"] as const) : (["GET"] as const);

  server.registerTool(
    "reddit_request",
    {
      description:
        "Call any Reddit API endpoint directly, for the many endpoints this server does not " +
        "wrap. Paths are relative to https://oauth.reddit.com — e.g. `/r/rust/about/rules`. " +
        "The response is returned raw and unshaped, so keep `limit` small: an unshaped listing " +
        "is roughly ten times the size of what the other tools return. " +
        (allowWrites
          ? "Writes are ENABLED, so POST is permitted — there is no confirmation step here, so " +
            "check the path before you call it."
          : "Writes are DISABLED: only GET is permitted. Set REDDIT_ALLOW_WRITES=1 and sign in " +
            "to allow POST."),
      inputSchema: {
        method: z.enum(methods).default("GET").describe("HTTP method."),
        path: z
          .string()
          .min(1)
          .describe('Path below the API root, starting with "/", e.g. "/r/rust/about/rules".'),
        query: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query parameters for a GET."),
        form: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Form fields for a POST. Reddit takes form encoding, never JSON."),
        asUser: z
          .boolean()
          .default(false)
          .describe(
            "Send with the signed-in user's token rather than the anonymous app token. " +
              "Required for anything under /api/v1/me, /message or /subreddits/mine.",
          ),
      },
      annotations: { readOnlyHint: !allowWrites, destructiveHint: allowWrites },
    },
    async ({ method, path, query, form, asUser }) =>
      wrap(async () => {
        // Belt and braces: the enum already excludes POST, but a client could
        // hand-roll a request that skips schema validation.
        if (!allowWrites && method !== "GET") {
          throw new WritesDisabledError(`reddit_request with method ${method}`);
        }
        assertSafePath(path);
        return client.request(method, path, {
          ...(query ? { query } : {}),
          ...(form ? { form } : {}),
          auth: asUser || method === "POST" ? "user" : "app",
        });
      }),
  );

  server.registerTool(
    "reddit_rate_limit_status",
    {
      description:
        "Report what Reddit has said about your remaining budget on each endpoint used so " +
        "far this session. Reddit allows roughly 100 requests per minute per OAuth client; " +
        "check here before a large paginated read rather than after a 429.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const snapshot = client.rateLimitSnapshot();
        return {
          endpoints: snapshot,
          ...(Object.keys(snapshot).length === 0
            ? { note: "No requests made yet this session, so Reddit has not reported a budget." }
            : {}),
        };
      }),
  );
};
