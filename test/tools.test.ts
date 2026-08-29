import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticTokenProvider } from "../src/client/auth.js";
import { memoryTokenStore, TOKEN_FILE_VERSION } from "../src/client/tokens.js";
import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

const listing = (children: unknown[], after?: string) => ({
  kind: "Listing",
  data: { after: after ?? null, before: null, children },
});

const post = (over: Record<string, unknown> = {}) => ({
  kind: "t3",
  data: {
    id: "1abc2de",
    name: "t3_1abc2de",
    title: "A post",
    subreddit: "rust",
    author: "someone",
    score: 42,
    upvote_ratio: 0.97,
    num_comments: 7,
    created_utc: 1_735_689_600,
    permalink: "/r/rust/comments/1abc2de/a_post/",
    is_self: true,
    selftext: "body",
    // The noise a shaped response must not carry through.
    link_flair_css_class: null,
    mod_reports: [],
    secure_media_embed: {},
    thumbnail_height: null,
    ...over,
  },
});

const SIGNED_IN = {
  version: TOKEN_FILE_VERSION,
  refreshToken: "stored-refresh",
  scopes: ["identity", "read"],
  obtainedAt: 1_735_689_600,
};

const ENV = {
  configured: { REDDIT_CLIENT_ID: "cid", REDDIT_TOKEN_PATH: "/nonexistent/tokens.json" },
  writes: {
    REDDIT_CLIENT_ID: "cid",
    REDDIT_ALLOW_WRITES: "1",
    REDDIT_TOKEN_PATH: "/nonexistent/tokens.json",
  },
  /** Retries are real and exponential, so error-path tests turn them off. */
  noRetry: {
    REDDIT_CLIENT_ID: "cid",
    REDDIT_MAX_RETRIES: "0",
    REDDIT_TOKEN_PATH: "/nonexistent/tokens.json",
  },
};

type ConnectOpts = { signedIn?: boolean };

const connect = async (
  env: Record<string, string> = ENV.configured,
  fetchImpl?: ReturnType<typeof vi.fn>,
  opts: ConnectOpts = {},
) => {
  // An absolute, non-existent token path keeps a developer's real
  // ~/.config/reddit/tokens.json out of the suite — without it these tests pass
  // on one machine and fail in CI, or worse, the reverse.
  const config: Config = loadConfig(env);
  const fetchMock = fetchImpl ?? vi.fn(async () => jsonResponse(listing([])));
  const store = memoryTokenStore(opts.signedIn ? SIGNED_IN : undefined);
  const { server } = createServer({
    config,
    store,
    fetch: fetchMock as unknown as typeof fetch,
    tokenProvider: staticTokenProvider("test-token", opts.signedIn ?? false),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    fetchMock,
    store,
    toolNames: async () => (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tools: async () => (await client.listTools()).tools,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) };
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true };
      } catch {
        return { isToolError: res.isError === true, error: text };
      }
    },
    urls: () => fetchMock.mock.calls.map((c) => String(c[0])),
    bodies: () =>
      fetchMock.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.body ?? "")),
  };
};

describe("registration matrix", () => {
  // The regression that produces "MCP error -32000: Connection closed": a server
  // that exits when credentials are missing takes the credential-free tools with
  // it and leaves no way to discover what to configure.
  it("connects with nothing configured, serving only the auth tools", async () => {
    const names = await (
      await connect({ REDDIT_TOKEN_PATH: "/nonexistent/tokens.json" })
    ).toolNames();
    expect(names).toEqual([
      "reddit_auth_login",
      "reddit_auth_logout",
      "reddit_auth_status",
      "reddit_auth_url",
    ]);
  });

  it("adds public browsing as soon as a client id exists, with no login", async () => {
    const names = await (await connect()).toolNames();
    expect(names).toContain("reddit_list_posts");
    expect(names).toContain("reddit_search");
    expect(names).toContain("reddit_get_post");
    // Account-scoped tools need a real login, so they must be absent.
    expect(names).not.toContain("reddit_get_saved");
    expect(names).not.toContain("reddit_list_subscriptions");
  });

  it("adds the account tools only once signed in", async () => {
    const names = await (await connect(ENV.configured, undefined, { signedIn: true })).toolNames();
    expect(names).toContain("reddit_list_subscriptions");
    expect(names).toContain("reddit_get_saved");
    expect(names).toContain("reddit_get_inbox");
    expect(names).toContain("reddit_get_me");
  });

  it("does not register the write tools when REDDIT_ALLOW_WRITES is unset", async () => {
    const names = await (await connect(ENV.configured, undefined, { signedIn: true })).toolNames();
    for (const tool of [
      "reddit_submit_post",
      "reddit_reply",
      "reddit_vote",
      "reddit_delete",
      "reddit_edit",
      "reddit_send_message",
    ]) {
      expect(names).not.toContain(tool);
    }
  });

  it("registers the write tools with the flag on and a login", async () => {
    const names = await (await connect(ENV.writes, undefined, { signedIn: true })).toolNames();
    expect(names).toEqual([
      "reddit_auth_login",
      "reddit_auth_logout",
      "reddit_auth_status",
      "reddit_auth_url",
      "reddit_delete",
      "reddit_edit",
      "reddit_get_inbox",
      "reddit_get_me",
      "reddit_get_more_comments",
      "reddit_get_post",
      "reddit_get_saved",
      "reddit_get_subreddit",
      "reddit_get_user",
      "reddit_list_posts",
      "reddit_list_subscriptions",
      "reddit_list_user_comments",
      "reddit_list_user_posts",
      "reddit_rate_limit_status",
      "reddit_reply",
      "reddit_request",
      "reddit_save",
      "reddit_search",
      "reddit_send_message",
      "reddit_submit_post",
      "reddit_subscribe",
      "reddit_vote",
    ]);
  });

  it("keeps the write flag inert without a login", async () => {
    const names = await (await connect(ENV.writes)).toolNames();
    expect(names).not.toContain("reddit_submit_post");
  });
});

describe("annotations", () => {
  it("marks every tool, and flags the irreversible ones as destructive", async () => {
    const tools = await (await connect(ENV.writes, undefined, { signedIn: true })).tools();
    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} has no annotations`).toBeDefined();
    }
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("reddit_delete")?.destructiveHint).toBe(true);
    expect(byName.get("reddit_edit")?.destructiveHint).toBe(true);
    expect(byName.get("reddit_list_posts")?.readOnlyHint).toBe(true);
    // Creating a post is a write but not destructive, and never idempotent.
    expect(byName.get("reddit_submit_post")?.destructiveHint).toBe(false);
    expect(byName.get("reddit_submit_post")?.idempotentHint).toBe(false);
  });

  it("narrows reddit_request to read-only when writes are off", async () => {
    const tools = await (await connect(ENV.configured)).tools();
    const request = tools.find((t) => t.name === "reddit_request");
    expect(request?.annotations?.readOnlyHint).toBe(true);
    expect(request?.description).toContain("Writes are DISABLED");
  });
});

describe("auth status", () => {
  it("reads as a setup guide when nothing is configured", async () => {
    const res = await (
      await connect({ REDDIT_TOKEN_PATH: "/nonexistent/tokens.json" })
    ).call("reddit_auth_status");
    expect(res.configured).toBe(false);
    const setup = (res.setup as string[]).join(" ");
    expect(setup).toContain("REDDIT_CLIENT_ID");
    expect(setup).toContain("reddit.com/prefs/apps");
    expect(setup).toContain("REDDIT_USER_AGENT");
  });

  it("reports anonymous mode once a client id exists", async () => {
    const res = await (await connect()).call("reddit_auth_status");
    expect(res.configured).toBe(true);
    expect(res.signedIn).toBe(false);
    expect(res.mode).toContain("anonymous");
  });
});

describe("requests", () => {
  it("asks Reddit for the sort and window the caller chose", async () => {
    const h = await connect();
    await h.call("reddit_list_posts", { subreddit: "rust", sort: "top", time: "week", limit: 5 });
    const url = h.urls()[0] ?? "";
    expect(url).toContain("/r/rust/top");
    expect(url).toContain("t=week");
    expect(url).toContain("limit=5");
    // raw_json=1 stops Reddit HTML-escaping &, < and > in every body.
    expect(url).toContain("raw_json=1");
  });

  it("omits the time window for sorts that ignore it", async () => {
    const h = await connect();
    await h.call("reddit_list_posts", { subreddit: "rust", sort: "new" });
    // `t` specifically — a substring check would match the `t=` inside `limit=`.
    expect(new URL(h.urls()[0]!).searchParams.has("t")).toBe(false);
  });

  it("restricts a subreddit search rather than silently searching all of Reddit", async () => {
    const h = await connect();
    await h.call("reddit_search", { query: "borrow checker", subreddit: "rust" });
    expect(h.urls()[0]).toContain("restrict_sr=1");
  });

  it("does not send restrict_sr for a site-wide search", async () => {
    const h = await connect();
    await h.call("reddit_search", { query: "borrow checker" });
    expect(h.urls()[0]).not.toContain("restrict_sr");
  });

  it("rejects a malformed subreddit at the schema layer, before any request", async () => {
    const h = await connect();
    const res = await h.call("reddit_list_posts", { subreddit: "r/rust" });
    expect(res.isToolError).toBe(true);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe("shaping", () => {
  it("returns the fields that matter and drops the ~90 that do not", async () => {
    const h = await connect(
      ENV.configured,
      vi.fn(async () => jsonResponse(listing([post()], "t3_next"))),
    );
    const res = await h.call("reddit_list_posts", { subreddit: "rust" });
    const item = (res.items as Record<string, unknown>[])[0]!;
    expect(item.id).toBe("t3_1abc2de");
    expect(item.title).toBe("A post");
    expect(item.selftext).toBe("body");
    expect(item.permalink).toBe("https://www.reddit.com/r/rust/comments/1abc2de/a_post/");
    // created_utc is rendered as ISO, because 1735689600 means nothing to a reader.
    expect(item.created).toBe("2025-01-01T00:00:00.000Z");
    for (const noise of [
      "mod_reports",
      "secure_media_embed",
      "thumbnail_height",
      "link_flair_css_class",
    ]) {
      expect(item).not.toHaveProperty(noise);
    }
    // The cursor survives — dropping it makes pagination impossible.
    expect(res.after).toBe("t3_next");
  });

  it("returns url for a link post and selftext for a self post, never both", async () => {
    const h = await connect(
      ENV.configured,
      vi.fn(async () =>
        jsonResponse(listing([post({ is_self: false, url: "https://example.com" })])),
      ),
    );
    const res = await h.call("reddit_list_posts", { subreddit: "rust" });
    const item = (res.items as Record<string, unknown>[])[0]!;
    expect(item.url).toBe("https://example.com");
    expect(item).not.toHaveProperty("selftext");
  });
});

describe("error handling", () => {
  it("quotes the rate-limit window in a 429 instead of just saying rate limited", async () => {
    const h = await connect(
      ENV.noRetry,
      vi.fn(async () =>
        jsonResponse(
          { message: "Too Many Requests", error: 429 },
          {
            status: 429,
            headers: {
              "x-ratelimit-used": "100",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "37",
            },
          },
        ),
      ),
    );
    const res = await h.call("reddit_list_posts", { subreddit: "rust" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain("rate limited");
    expect(res.error).toContain("resets in 37s");
  });

  it("explains a 403 as a scope or private-subreddit problem", async () => {
    const h = await connect(
      ENV.noRetry,
      vi.fn(async () => jsonResponse({ message: "Forbidden" }, { status: 403 })),
    );
    const res = await h.call("reddit_get_subreddit", { subreddit: "private" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain("private or quarantined");
  });
});
