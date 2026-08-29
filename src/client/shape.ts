// Reddit answers with `Thing` envelopes — `{kind: "t3", data: {...}}` — wrapped
// in `Listing`s: `{kind: "Listing", data: {after, before, children: [...]}}`.
// A single post's `data` carries ~110 fields, most of them null, deprecated, or
// UI state (`link_flair_css_class`, `mod_reports`, `secure_media_embed`, three
// separate thumbnail sizes). Returning that raw costs a large multiple of the
// tokens the content is worth, so every list tool summarizes and keeps only the
// pagination cursor.
//
// `get_*` tools still return the summarized form here rather than the full
// object: unlike a JSON:API resource, none of the extra 90 fields is something
// a caller asked for.

type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

/** Reddit's fullname prefixes. Every id a write tool takes is one of these. */
export const KINDS = {
  comment: "t1",
  account: "t2",
  post: "t3",
  message: "t4",
  subreddit: "t5",
} as const;

/**
 * Reddit ids appear in three forms — bare (`1abc2de`), prefixed (`t3_1abc2de`)
 * and as a URL. Tools take any of them and normalize here, because getting this
 * wrong produces an empty result rather than an error.
 */
export const toFullname = (id: string, kind: keyof typeof KINDS): string => {
  const trimmed = id.trim();
  const fromUrl = trimmed.match(/\/comments\/([a-z0-9]+)/i)?.[1];
  const bare = fromUrl ?? trimmed.replace(/^t[1-6]_/, "");
  return `${KINDS[kind]}_${bare}`;
};

/** Seconds since epoch → ISO, because a bare 1735689600 means nothing to a reader. */
const iso = (epochSeconds: unknown): string | undefined => {
  const n = num(epochSeconds);
  return n === undefined || n <= 0 ? undefined : new Date(n * 1000).toISOString();
};

export const summarizePost = (data: Rec): Rec => ({
  id: str(data.name) ?? `t3_${String(data.id)}`,
  title: data.title,
  subreddit: data.subreddit,
  author: data.author,
  score: data.score,
  upvoteRatio: data.upvote_ratio,
  comments: data.num_comments,
  created: iso(data.created_utc),
  permalink: str(data.permalink) ? `https://www.reddit.com${String(data.permalink)}` : undefined,
  // `is_self` decides which of these is meaningful; both are noise otherwise.
  ...(data.is_self ? { selftext: data.selftext } : { url: data.url }),
  ...(str(data.link_flair_text) ? { flair: data.link_flair_text } : {}),
  ...(bool(data.over_18) ? { nsfw: true } : {}),
  ...(bool(data.stickied) ? { stickied: true } : {}),
  ...(bool(data.locked) ? { locked: true } : {}),
});

export const summarizeComment = (data: Rec, depth = 0): Rec => ({
  id: str(data.name) ?? `t1_${String(data.id)}`,
  author: data.author,
  body: data.body,
  score: data.score,
  created: iso(data.created_utc),
  depth,
  ...(str(data.parent_id) ? { parent: data.parent_id } : {}),
  ...(bool(data.stickied) ? { stickied: true } : {}),
});

export const summarizeSubreddit = (data: Rec): Rec => ({
  id: str(data.name) ?? `t5_${String(data.id)}`,
  name: data.display_name,
  title: data.title,
  subscribers: data.subscribers,
  activeUsers: data.active_user_count,
  created: iso(data.created_utc),
  description: data.public_description,
  url: str(data.url) ? `https://www.reddit.com${String(data.url)}` : undefined,
  ...(bool(data.over18) ? { nsfw: true } : {}),
  ...(str(data.subreddit_type) ? { type: data.subreddit_type } : {}),
});

export const summarizeAccount = (data: Rec): Rec => ({
  id: str(data.name) ? `t2_${String(data.id)}` : undefined,
  username: data.name,
  created: iso(data.created_utc),
  linkKarma: data.link_karma,
  commentKarma: data.comment_karma,
  totalKarma: data.total_karma,
  ...(bool(data.is_gold) ? { gold: true } : {}),
  ...(bool(data.is_mod) ? { mod: true } : {}),
});

export const summarizeMessage = (data: Rec): Rec => ({
  id: str(data.name),
  from: data.author,
  subject: data.subject,
  body: data.body,
  created: iso(data.created_utc),
  ...(bool(data.new) ? { unread: true } : {}),
  ...(str(data.subreddit) ? { subreddit: data.subreddit } : {}),
});

/** Route one Thing to the right summarizer by its `kind`. */
export const summarizeThing = (thing: unknown): Rec | undefined => {
  if (!isRecord(thing)) return undefined;
  const data = isRecord(thing.data) ? thing.data : undefined;
  if (!data) return undefined;
  switch (thing.kind) {
    case "t1":
      return summarizeComment(data);
    case "t2":
      return summarizeAccount(data);
    case "t3":
      return summarizePost(data);
    case "t4":
      return summarizeMessage(data);
    case "t5":
      return summarizeSubreddit(data);
    default:
      return undefined;
  }
};

export type ShapedListing = {
  items: Rec[];
  after?: string;
  before?: string;
};

/**
 * Flatten a Listing to its summarized children plus the cursor. `after` is kept
 * because dropping it makes pagination impossible, which is the easy mistake
 * here — the items look fine and the caller simply cannot get page two.
 */
export const summarizeListing = (response: unknown): ShapedListing => {
  const data = isRecord(response) && isRecord(response.data) ? response.data : undefined;
  const children = Array.isArray(data?.children) ? data.children : [];
  return {
    items: children.map(summarizeThing).filter((x): x is Rec => x !== undefined),
    ...(str(data?.after) ? { after: String(data?.after) } : {}),
    ...(str(data?.before) ? { before: String(data?.before) } : {}),
  };
};

export type ShapedComments = {
  comments: Rec[];
  /** Ids Reddit did not expand, and how many replies they stand for. */
  unexpanded: { parent: string; count: number; ids: string[] }[];
  truncated: boolean;
};

/**
 * Flatten a comment tree to a depth-tagged list.
 *
 * Returning the nesting as-is is the single biggest context-window risk in this
 * API: a busy thread is unbounded in both breadth and depth, and the nested form
 * is larger than the flat one for no added meaning — the `depth` field carries
 * the same information a model needs.
 *
 * `kind: "more"` stubs are counted and reported rather than dropped. A caller
 * who does not know 400 replies were omitted will draw conclusions from the 20
 * they got, which is worse than being told the tree was cut.
 */
export const summarizeCommentTree = (
  node: unknown,
  opts: { maxDepth: number; maxComments: number },
): ShapedComments => {
  const comments: Rec[] = [];
  const unexpanded: ShapedComments["unexpanded"] = [];
  let truncated = false;

  const visit = (thing: unknown, depth: number, parentId: string): void => {
    if (!isRecord(thing)) return;
    const data = isRecord(thing.data) ? thing.data : undefined;
    if (!data) return;

    if (thing.kind === "more") {
      const ids = Array.isArray(data.children) ? data.children.map(String) : [];
      // Reddit's "continue this thread" stub has count 0 but real children.
      const count = num(data.count) ?? ids.length;
      if (count > 0 || ids.length > 0) unexpanded.push({ parent: parentId, count, ids });
      return;
    }
    if (thing.kind !== "t1") return;

    if (comments.length >= opts.maxComments) {
      truncated = true;
      return;
    }
    comments.push(summarizeComment(data, depth));

    if (depth >= opts.maxDepth) {
      const replies = isRecord(data.replies) ? data.replies : undefined;
      const kids =
        isRecord(replies?.data) && Array.isArray(replies.data.children)
          ? replies.data.children.length
          : 0;
      if (kids > 0) {
        unexpanded.push({ parent: String(data.name), count: kids, ids: [] });
      }
      return;
    }

    // `replies` is "" rather than an empty Listing when a comment has none.
    const replies = isRecord(data.replies) ? data.replies : undefined;
    const children =
      isRecord(replies?.data) && Array.isArray(replies.data.children) ? replies.data.children : [];
    for (const child of children) visit(child, depth + 1, String(data.name));
  };

  const data = isRecord(node) && isRecord(node.data) ? node.data : undefined;
  const roots = Array.isArray(data?.children) ? data.children : [];
  for (const root of roots) visit(root, 0, "");

  return { comments, unexpanded, truncated };
};
