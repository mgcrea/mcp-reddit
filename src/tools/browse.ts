import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RedditClient } from "../client/reddit.js";
import {
  summarizeCommentTree,
  summarizeListing,
  summarizeSubreddit,
  toFullname,
  isRecord,
} from "../client/shape.js";
import type { ToolContext } from "./index.js";
import {
  afterArg,
  compact,
  limitArg,
  postIdArg,
  sortArg,
  subredditArg,
  timeArg,
  wrap,
} from "./util.js";

export const registerBrowseTools = (
  server: McpServer,
  client: RedditClient,
  _ctx: ToolContext,
): void => {
  server.registerTool(
    "reddit_list_posts",
    {
      description:
        "List posts from a subreddit, or from the site-wide front page when `subreddit` is " +
        "omitted. Returns each post's id, title, author, score, comment count and permalink — " +
        "the body text or link, but never the comments. Use reddit_get_post for one thread's " +
        "discussion; fetching 25 posts' comment trees is orders of magnitude more text than " +
        "this.",
      inputSchema: {
        subreddit: subredditArg.optional(),
        sort: sortArg,
        time: timeArg,
        limit: limitArg,
        after: afterArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ subreddit, sort, time, limit, after }) =>
      wrap(async () => {
        const path = subreddit ? `/r/${subreddit}/${sort}` : `/${sort}`;
        // `t` is only meaningful for top/controversial; sending it elsewhere is
        // harmless but noise, and omitting it keeps the request honest.
        const needsTime = sort === "top" || sort === "controversial";
        return summarizeListing(
          await client.get(path, compact({ limit, after, t: needsTime ? time : undefined })),
        );
      }),
  );

  server.registerTool(
    "reddit_get_subreddit",
    {
      description:
        "Get one subreddit's description, subscriber count and current active users. Useful " +
        "before listing posts, to confirm the name is right and the community is the one you " +
        "meant — Reddit returns 404 for both a misspelling and a banned subreddit.",
      inputSchema: { subreddit: subredditArg },
      annotations: { readOnlyHint: true },
    },
    async ({ subreddit }) =>
      wrap(async () => {
        const res = await client.get(`/r/${subreddit}/about`);
        const data = isRecord(res) && isRecord(res.data) ? res.data : {};
        return summarizeSubreddit(data);
      }),
  );

  server.registerTool(
    "reddit_search",
    {
      description:
        "Search Reddit. Scoped to one subreddit when `subreddit` is given, site-wide " +
        "otherwise. Reddit's index is weaker than a web search engine's: prefer a few " +
        "distinctive words over a natural-language question, and note that `sort=relevance` " +
        "over `time=all` is usually better than `new` for finding the canonical thread.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            'Search terms. Supports Reddit operators like `author:spez` and `flair:"help"`.',
          ),
        subreddit: subredditArg.optional(),
        sort: z
          .enum(["relevance", "hot", "top", "new", "comments"])
          .default("relevance")
          .describe("Result ordering. `comments` sorts by comment count."),
        time: timeArg,
        limit: limitArg,
        after: afterArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, subreddit, sort, time, limit, after }) =>
      wrap(async () =>
        summarizeListing(
          await client.get(
            subreddit ? `/r/${subreddit}/search` : "/search",
            compact({
              q: query,
              sort,
              t: time,
              limit,
              after,
              // Without this Reddit widens a subreddit search to the whole site
              // and silently returns results from everywhere.
              ...(subreddit ? { restrict_sr: 1 } : {}),
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "reddit_get_post",
    {
      description:
        "Get one post together with its comment thread, flattened to a depth-tagged list. " +
        "Comment trees are the largest thing this API returns, so `maxComments` and `maxDepth` " +
        "are deliberately low: raise them when you actually need the long tail. Replies that " +
        "were not expanded are reported under `unexpanded` with their ids, so nothing is " +
        "dropped silently — pass those ids to reddit_get_more_comments.",
      inputSchema: {
        postId: postIdArg,
        sort: z
          .enum(["confidence", "top", "new", "controversial", "old", "qa"])
          .default("confidence")
          .describe("Comment ordering. `confidence` is Reddit's default 'best'."),
        maxComments: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Stop after this many comments (1-500). Defaults to 50."),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(3)
          .describe("How deep to walk reply chains (0-10). Defaults to 3."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ postId, sort, maxComments, maxDepth }) =>
      wrap(async () => {
        const id = toFullname(postId, "post").replace(/^t3_/, "");
        // /comments/{id} answers with a two-element array: the post as a
        // one-item Listing, then the comment Listing. Not a Thing, not an object.
        const res = await client.get<unknown[]>(
          `/comments/${id}`,
          compact({ sort, limit: maxComments, depth: maxDepth + 1 }),
        );
        const [postListing, commentListing] = Array.isArray(res) ? res : [];
        const post = summarizeListing(postListing).items[0];
        const thread = summarizeCommentTree(commentListing, { maxComments, maxDepth });
        return {
          post,
          ...thread,
          ...(thread.truncated
            ? { note: `Stopped at ${maxComments} comments. Raise maxComments for more.` }
            : {}),
        };
      }),
  );

  server.registerTool(
    "reddit_get_more_comments",
    {
      description:
        "Expand the reply stubs reddit_get_post reported under `unexpanded`. Pass the post id " +
        "and the ids from one stub. This is the only way to reach a deep thread's tail — " +
        "re-fetching the post with a bigger maxDepth walks the same top-level branches again " +
        "rather than continuing where it stopped.",
      inputSchema: {
        postId: postIdArg,
        commentIds: z
          .array(z.string().min(1))
          .min(1)
          .max(100)
          .describe("Comment ids from an `unexpanded[].ids` array, up to 100 per call."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ postId, commentIds }) =>
      wrap(async () => {
        const res = await client.get<unknown>(
          "/api/morechildren",
          compact({
            api_type: "json",
            link_id: toFullname(postId, "post"),
            // Reddit wants these comma-joined in one parameter, not repeated keys.
            children: commentIds.map((c) => c.replace(/^t1_/, "")).join(","),
          }),
        );
        const things =
          isRecord(res) && isRecord(res.json) && isRecord(res.json.data)
            ? res.json.data.things
            : undefined;
        const thread = summarizeCommentTree(
          { data: { children: Array.isArray(things) ? things : [] } },
          { maxComments: 500, maxDepth: 10 },
        );
        return thread;
      }),
  );
};
