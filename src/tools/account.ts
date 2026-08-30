import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { RedditClient } from "#/client/reddit";
import { isRecord, summarizeAccount, summarizeListing } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { afterArg, compact, limitArg, wrap } from "#/tools/util";

/**
 * Everything here needs the signed-in user's own data, so these are registered
 * only once a refresh token exists. With no login they are absent rather than
 * failing — reddit_auth_status explains why.
 */
export const registerAccountTools = (
  server: McpServer,
  client: RedditClient,
  _ctx: ToolContext,
): void => {
  server.registerTool(
    "reddit_get_me",
    {
      title: "Reddit: Get Me",
      description:
        "Get the signed-in account: username, karma and account age. Use it to confirm which " +
        "account this server is acting as before writing anything.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const res = await client.get("/api/v1/me", undefined, "user");
        // Unlike /user/x/about this endpoint returns the account data bare,
        // with no Thing wrapper.
        return summarizeAccount(isRecord(res) ? res : {});
      }),
  );

  server.registerTool(
    "reddit_list_subscriptions",
    {
      title: "Reddit: List Subscriptions",
      description:
        "List the subreddits the signed-in account subscribes to. This is the cheapest way to " +
        "answer 'what do I follow' — reading the front page tells you what is popular there " +
        "today, not what you subscribed to.",
      inputSchema: z.object({ limit: limitArg, after: afterArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, after }) =>
      wrap(async () =>
        summarizeListing(
          await client.get("/subreddits/mine/subscriber", compact({ limit, after }), "user"),
        ),
      ),
  );

  server.registerTool(
    "reddit_get_saved",
    {
      title: "Reddit: Get Saved",
      description:
        "List the posts and comments the signed-in account has saved. The listing mixes both " +
        "kinds — each item's id prefix tells you which (`t3_` post, `t1_` comment).",
      inputSchema: z.object({
        limit: limitArg,
        after: afterArg,
        type: z
          .enum(["all", "links", "comments"])
          .default("all")
          .describe("Restrict to saved posts or saved comments. Defaults to both."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit, after, type }) =>
      wrap(async () => {
        const me = await client.get<{ name?: string }>("/api/v1/me", undefined, "user");
        return summarizeListing(
          await client.get(
            `/user/${me.name}/saved`,
            compact({ limit, after, type: type === "all" ? undefined : type }),
            "user",
          ),
        );
      }),
  );

  server.registerTool(
    "reddit_get_inbox",
    {
      title: "Reddit: Get Inbox",
      description:
        "Read the signed-in account's inbox — private messages, comment replies and username " +
        "mentions. Reading here does not mark anything read on Reddit.",
      inputSchema: z.object({
        box: z
          .enum(["inbox", "unread", "messages", "comments", "mentions"])
          .default("inbox")
          .describe("Which inbox view. `inbox` is everything; `unread` is only what is new."),
        limit: limitArg,
        after: afterArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ box, limit, after }) =>
      wrap(async () =>
        summarizeListing(await client.get(`/message/${box}`, compact({ limit, after }), "user")),
      ),
  );
};
