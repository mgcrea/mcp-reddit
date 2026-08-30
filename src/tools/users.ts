import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { RedditClient } from "#/client/reddit";
import { isRecord, summarizeAccount, summarizeListing } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { afterArg, compact, limitArg, sortArg, timeArg, usernameArg, wrap } from "#/tools/util";

export const registerUserTools = (
  server: McpServer,
  client: RedditClient,
  _ctx: ToolContext,
): void => {
  server.registerTool(
    "reddit_get_user",
    {
      title: "Reddit: Get User",
      description:
        "Get a Reddit account's karma, age and flags. Works for any public account without a " +
        "login. Suspended and shadowbanned accounts return 404, not an empty profile.",
      inputSchema: z.object({ username: usernameArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ username }) =>
      wrap(async () => {
        const res = await client.get(`/user/${username}/about`);
        return summarizeAccount(isRecord(res) && isRecord(res.data) ? res.data : {});
      }),
  );

  server.registerTool(
    "reddit_list_user_posts",
    {
      title: "Reddit: List User Posts",
      description:
        "List the posts an account has submitted, newest first by default. Reddit only serves " +
        "roughly the last 1000 items of any user listing however far you paginate, so this " +
        "cannot reconstruct a full history for a prolific account.",
      inputSchema: z.object({
        username: usernameArg,
        sort: sortArg,
        time: timeArg,
        limit: limitArg,
        after: afterArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, sort, time, limit, after }) =>
      wrap(async () =>
        summarizeListing(
          await client.get(`/user/${username}/submitted`, compact({ sort, t: time, limit, after })),
        ),
      ),
  );

  server.registerTool(
    "reddit_list_user_comments",
    {
      title: "Reddit: List User Comments",
      description:
        "List the comments an account has written. Same ~1000-item ceiling as " +
        "reddit_list_user_posts. Each comment carries its parent id, so you can follow one " +
        "back to its thread with reddit_get_post.",
      inputSchema: z.object({
        username: usernameArg,
        sort: sortArg,
        time: timeArg,
        limit: limitArg,
        after: afterArg,
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ username, sort, time, limit, after }) =>
      wrap(async () =>
        summarizeListing(
          await client.get(`/user/${username}/comments`, compact({ sort, t: time, limit, after })),
        ),
      ),
  );
};
