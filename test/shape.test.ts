import { describe, expect, it } from "vitest";

import { summarizeCommentTree, summarizeListing, summarizeThing, toFullname } from "#/client/shape";

const comment = (id: string, body: string, replies: unknown = "") => ({
  kind: "t1",
  data: {
    id,
    name: `t1_${id}`,
    author: "someone",
    body,
    score: 3,
    created_utc: 1_735_689_600,
    parent_id: "t3_root",
    replies,
    // Reddit ships a lot of moderation and UI state on every comment.
    mod_reports: [],
    author_flair_richtext: [],
    collapsed_reason_code: null,
  },
});

const listing = (children: unknown[]) => ({ kind: "Listing", data: { children } });

describe("toFullname", () => {
  // Reddit ids appear bare, prefixed, and inside URLs. Getting this wrong
  // produces an empty result rather than an error, so all three must normalize.
  it.each([
    ["1abc2de", "t3_1abc2de"],
    ["t3_1abc2de", "t3_1abc2de"],
    ["https://www.reddit.com/r/rust/comments/1abc2de/some_title/", "t3_1abc2de"],
    ["  1abc2de  ", "t3_1abc2de"],
  ])("normalizes %s", (input, expected) => {
    expect(toFullname(input, "post")).toBe(expected);
  });
});

describe("summarizeThing", () => {
  it("routes each kind to its own summarizer", () => {
    expect(summarizeThing({ kind: "t5", data: { display_name: "rust", id: "2s" } })).toMatchObject({
      name: "rust",
    });
    expect(summarizeThing({ kind: "t2", data: { name: "spez", id: "1w" } })).toMatchObject({
      username: "spez",
    });
  });

  it("drops a kind it does not understand rather than passing it through raw", () => {
    expect(summarizeThing({ kind: "t6", data: { anything: true } })).toBeUndefined();
    expect(summarizeThing("not a thing")).toBeUndefined();
  });
});

describe("summarizeListing", () => {
  it("keeps the cursor, because dropping it makes pagination impossible", () => {
    const shaped = summarizeListing({
      kind: "Listing",
      data: { after: "t3_next", before: "t3_prev", children: [] },
    });
    expect(shaped.after).toBe("t3_next");
    expect(shaped.before).toBe("t3_prev");
  });

  it("omits a null cursor instead of emitting after: null", () => {
    const shaped = summarizeListing({ kind: "Listing", data: { after: null, children: [] } });
    expect(shaped).not.toHaveProperty("after");
  });

  it("survives a malformed response rather than throwing mid-tool", () => {
    expect(summarizeListing(undefined).items).toEqual([]);
    expect(summarizeListing({ kind: "Listing" }).items).toEqual([]);
  });
});

describe("summarizeCommentTree", () => {
  it("flattens nesting to a depth-tagged list", () => {
    const tree = listing([
      comment("a", "top", listing([comment("b", "reply", listing([comment("c", "deep")]))])),
    ]);
    const shaped = summarizeCommentTree(tree, { maxDepth: 5, maxComments: 100 });
    expect(shaped.comments.map((c) => [c.id, c.depth])).toEqual([
      ["t1_a", 0],
      ["t1_b", 1],
      ["t1_c", 2],
    ]);
    expect(shaped.truncated).toBe(false);
  });

  it("stops at maxDepth and reports what it did not walk", () => {
    const tree = listing([comment("a", "top", listing([comment("b", "reply")]))]);
    const shaped = summarizeCommentTree(tree, { maxDepth: 0, maxComments: 100 });
    expect(shaped.comments).toHaveLength(1);
    // The caller must be able to tell a leaf from a truncation.
    expect(shaped.unexpanded).toEqual([{ parent: "t1_a", count: 1, ids: [] }]);
  });

  it("stops at maxComments and says so", () => {
    const tree = listing([comment("a", "one"), comment("b", "two"), comment("c", "three")]);
    const shaped = summarizeCommentTree(tree, { maxDepth: 5, maxComments: 2 });
    expect(shaped.comments).toHaveLength(2);
    expect(shaped.truncated).toBe(true);
  });

  it("reports `more` stubs with their ids rather than dropping them", () => {
    // A caller who does not know 400 replies were omitted will draw conclusions
    // from the two they got.
    const tree = listing([
      comment("a", "top"),
      { kind: "more", data: { count: 400, children: ["x1", "x2"], name: "t1_more" } },
    ]);
    const shaped = summarizeCommentTree(tree, { maxDepth: 5, maxComments: 100 });
    expect(shaped.comments).toHaveLength(1);
    expect(shaped.unexpanded).toEqual([{ parent: "", count: 400, ids: ["x1", "x2"] }]);
  });

  it("keeps a `continue this thread` stub, which reports count 0 but has children", () => {
    const tree = listing([{ kind: "more", data: { count: 0, children: ["deep1"] } }]);
    const shaped = summarizeCommentTree(tree, { maxDepth: 5, maxComments: 100 });
    expect(shaped.unexpanded).toEqual([{ parent: "", count: 0, ids: ["deep1"] }]);
  });

  it("treats an empty-string `replies` as a leaf, which is how Reddit spells it", () => {
    const shaped = summarizeCommentTree(listing([comment("a", "leaf", "")]), {
      maxDepth: 5,
      maxComments: 100,
    });
    expect(shaped.comments).toHaveLength(1);
    expect(shaped.unexpanded).toEqual([]);
  });

  it("carries none of the moderation or UI noise into the output", () => {
    const shaped = summarizeCommentTree(listing([comment("a", "hi")]), {
      maxDepth: 5,
      maxComments: 100,
    });
    const first = shaped.comments[0]!;
    for (const noise of [
      "mod_reports",
      "author_flair_richtext",
      "collapsed_reason_code",
      "replies",
    ]) {
      expect(first).not.toHaveProperty(noise);
    }
  });
});
