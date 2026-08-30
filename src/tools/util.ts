import { z } from "zod";

import {
  RedditActionError,
  RedditApiError,
  UserContextRequiredError,
  WritesDisabledError,
} from "#/client/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }, null, 2) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a markdown document
 * into one escaped "# Title\n\n…" line that no one can read.
 */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }, null, 2),
    },
  ],
  isError: true,
});

/** Render a thrown value as a tool error, preserving Reddit's detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof RedditApiError) {
    return fail(err.message, {
      status: err.status,
      ...(err.rateLimit ? { rateLimit: err.rateLimit } : {}),
      errors: err.errors,
    });
  }
  if (err instanceof RedditActionError) return fail(err.message, err.details);
  if (err instanceof WritesDisabledError || err instanceof UserContextRequiredError) {
    return fail(err.message);
  }
  if (err instanceof Error) {
    const details = (err as Error & { details?: unknown }).details;
    return fail(err.message, details);
  }
  return fail("Unknown error", err);
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

// --- shared argument atoms ---------------------------------------------------

/**
 * Reddit caps every listing at 100 per request. The default is 25 rather than
 * the maximum because a shaped post is still ~15 lines, and 100 of them is most
 * of a context window for a browse that usually wants the top few.
 */
export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25)
  .describe("How many items to return (1-100). Defaults to 25; Reddit's hard cap is 100.");

export const afterArg = z
  .string()
  .optional()
  .describe(
    "Pagination cursor: pass the `after` value from the previous response to get the next " +
      "page. Reddit paginates by fullname, not by offset, so there is no page number.",
  );

export const subredditArg = z
  .string()
  .regex(
    /^[A-Za-z0-9_]{2,21}$/,
    "A subreddit name is 2-21 characters of letters, digits or underscore — no `r/` prefix and no spaces.",
  )
  .describe('Subreddit name without the `r/` prefix, e.g. "rust".');

export const usernameArg = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{3,20}$/,
    "A Reddit username is 3-20 characters of letters, digits, underscore or hyphen — no `u/` prefix.",
  )
  .describe('Reddit username without the `u/` prefix, e.g. "spez".');

export const postIdArg = z
  .string()
  .min(1)
  .describe(
    'A post id. Accepts the bare id ("1abc2de"), the fullname ("t3_1abc2de") or the full ' +
      "permalink — they are normalized for you.",
  );

export const sortArg = z
  .enum(["hot", "new", "top", "rising", "controversial"])
  .default("hot")
  .describe("Listing sort. `top` and `controversial` also read `time`.");

export const timeArg = z
  .enum(["hour", "day", "week", "month", "year", "all"])
  .default("day")
  .describe("Time window, used only by the `top` and `controversial` sorts. Ignored otherwise.");

/** Destructive tools require this, so an agent can never delete something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes your Reddit account.");

/** Drop undefined values so we never send `limit=undefined` to Reddit. */
export const compact = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
