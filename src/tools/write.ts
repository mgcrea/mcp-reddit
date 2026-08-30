import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RedditClient } from "#/client/reddit";
import { isRecord } from "#/client/shape";
import type { ToolContext } from "#/tools/index";
import { compact, confirmArg, subredditArg, usernameArg, wrap } from "#/tools/util";

/**
 * Registered only when REDDIT_ALLOW_WRITES is set AND a user is signed in, so
 * with the defaults these tools do not exist at all — an agent cannot call them,
 * not even to be refused.
 *
 * A thing id here may be a post or a comment, so these take the prefixed
 * fullname rather than guessing: `t3_` for a post, `t1_` for a comment.
 */
const thingIdArg = z
  .string()
  .regex(
    /^t[135]_[a-z0-9]+$/i,
    "Needs a prefixed fullname: `t3_…` for a post, `t1_` for a comment, `t5_` for a subreddit.",
  )
  .describe('A prefixed fullname, e.g. "t3_1abc2de" for a post or "t1_9xyz8wv" for a comment.');

export const registerWriteTools = (
  server: McpServer,
  client: RedditClient,
  _ctx: ToolContext,
): void => {
  server.registerTool(
    "reddit_submit_post",
    {
      title: "Reddit: Submit Post",
      description:
        "Submit a new post to a subreddit — either a self (text) post or a link. Most " +
        "subreddits enforce rules a bot cannot see: flair requirements, minimum account age, " +
        "karma thresholds. A rejection comes back as a Reddit error naming the rule, not as a " +
        "silent failure. Reddit also rate-limits new accounts to roughly one post every ten " +
        "minutes.",
      inputSchema: {
        subreddit: subredditArg,
        title: z
          .string()
          .min(1)
          .max(300)
          .describe("Post title, up to 300 characters. Reddit rejects anything longer."),
        text: z
          .string()
          .optional()
          .describe("Markdown body for a self post. Provide this or `url`, not both."),
        url: z.url().optional().describe("Target URL for a link post. Provide this or `text`."),
        flairId: z
          .string()
          .optional()
          .describe("Flair template id, where the subreddit requires one."),
        nsfw: z.boolean().default(false).describe("Mark the post NSFW."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ subreddit, title, text, url, flairId, nsfw }) =>
      wrap(async () => {
        if ((text === undefined) === (url === undefined)) {
          throw new Error("Provide exactly one of `text` (self post) or `url` (link post).");
        }
        const res = await client.post<unknown>(
          "/api/submit",
          compact({
            api_type: "json",
            sr: subreddit,
            kind: url === undefined ? "self" : "link",
            title,
            text,
            url,
            flair_id: flairId,
            nsfw,
            // Without this Reddit sends a "you posted" message to the account's
            // own inbox for every submission.
            sendreplies: true,
          }),
        );
        const data = isRecord(res) && isRecord(res.json) ? res.json.data : undefined;
        return { submitted: true, ...(isRecord(data) ? { id: data.name, url: data.url } : {}) };
      }),
  );

  server.registerTool(
    "reddit_reply",
    {
      title: "Reddit: Reply",
      description:
        "Reply to a post or a comment. The parent is a fullname: `t3_…` replies at top level " +
        "on a post, `t1_…` replies to a specific comment. Replying to a locked or archived " +
        "thread fails — Reddit archives posts after six months.",
      inputSchema: {
        parentId: thingIdArg,
        text: z.string().min(1).describe("Markdown body of the reply."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ parentId, text }) =>
      wrap(async () => {
        const res = await client.post<unknown>(
          "/api/comment",
          compact({ api_type: "json", thing_id: parentId, text }),
        );
        const things =
          isRecord(res) && isRecord(res.json) && isRecord(res.json.data)
            ? res.json.data.things
            : undefined;
        const first = Array.isArray(things) && isRecord(things[0]) ? things[0].data : undefined;
        return { replied: true, ...(isRecord(first) ? { id: first.name } : {}) };
      }),
  );

  server.registerTool(
    "reddit_vote",
    {
      title: "Reddit: Vote",
      description:
        "Upvote, downvote or clear your vote on a post or comment. Reddit's API terms forbid " +
        "automated voting that is not a deliberate human choice, and vote manipulation is a " +
        "bannable offence — use this to record a decision someone made, never to sweep a " +
        "listing.",
      inputSchema: {
        thingId: thingIdArg,
        direction: z
          .enum(["up", "down", "clear"])
          .describe("`up` = +1, `down` = -1, `clear` removes an existing vote."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ thingId, direction }) =>
      wrap(async () => {
        const dir = direction === "up" ? 1 : direction === "down" ? -1 : 0;
        await client.post("/api/vote", { id: thingId, dir });
        return { voted: direction, id: thingId };
      }),
  );

  server.registerTool(
    "reddit_save",
    {
      title: "Reddit: Save",
      description:
        "Save or unsave a post or comment to the signed-in account's saved list. Reads back " +
        "through reddit_get_saved.",
      inputSchema: {
        thingId: thingIdArg,
        saved: z.boolean().default(true).describe("True to save, false to unsave."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ thingId, saved }) =>
      wrap(async () => {
        await client.post(saved ? "/api/save" : "/api/unsave", { id: thingId });
        return { id: thingId, saved };
      }),
  );

  server.registerTool(
    "reddit_subscribe",
    {
      title: "Reddit: Subscribe",
      description:
        "Subscribe to or leave a subreddit. Changes what the signed-in account's front page " +
        "shows.",
      inputSchema: {
        subreddit: subredditArg,
        subscribe: z.boolean().default(true).describe("True to join, false to leave."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ subreddit, subscribe }) =>
      wrap(async () => {
        await client.post("/api/subscribe", {
          action: subscribe ? "sub" : "unsub",
          sr_name: subreddit,
        });
        return { subreddit, subscribed: subscribe };
      }),
  );

  server.registerTool(
    "reddit_send_message",
    {
      title: "Reddit: Send Message",
      description:
        "Send a private message to a Reddit user. Unsolicited messages are the fastest way to " +
        "get an account suspended, so send these only when a person asked for one. Reddit " +
        "throttles new or low-karma accounts here hard.",
      inputSchema: {
        to: usernameArg,
        subject: z.string().min(1).max(100).describe("Subject line, up to 100 characters."),
        text: z.string().min(1).describe("Markdown body of the message."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ to, subject, text }) =>
      wrap(async () => {
        await client.post("/api/compose", { api_type: "json", to, subject, text });
        return { sent: true, to };
      }),
  );

  server.registerTool(
    "reddit_delete",
    {
      title: "Reddit: Delete",
      description:
        "Delete one of your own posts or comments. Irreversible: Reddit keeps no undo, the id " +
        "cannot be reused, and third-party mirrors will still hold a copy. A deleted comment " +
        "leaves a `[deleted]` stub in the thread rather than vanishing.",
      inputSchema: { thingId: thingIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ thingId }) =>
      wrap(async () => {
        await client.post("/api/del", { id: thingId });
        return { deleted: thingId };
      }),
  );

  server.registerTool(
    "reddit_edit",
    {
      title: "Reddit: Edit",
      description:
        "Edit the body of one of your own self posts or comments. Reddit marks the item as " +
        "edited and shows the timestamp; the original text is not recoverable through the API. " +
        "Link posts cannot have their URL changed — only self posts and comments are editable.",
      inputSchema: {
        thingId: thingIdArg,
        text: z.string().min(1).describe("The new markdown body, replacing the old one entirely."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ thingId, text }) =>
      wrap(async () => {
        await client.post("/api/editusertext", { api_type: "json", thing_id: thingId, text });
        return { edited: thingId };
      }),
  );
};
