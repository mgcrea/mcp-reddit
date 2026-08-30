import { describe, expect, it } from "vitest";

import { effectiveScopes, loadConfig, setupInstructions, WRITE_SCOPES } from "#/config";

const base = { REDDIT_TOKEN_PATH: "/nonexistent/tokens.json" };

describe("loadConfig", () => {
  it("stays valid with nothing set, so the server can start and explain itself", () => {
    const config = loadConfig(base);
    expect(config.clientId).toBeUndefined();
    expect(config.allowWrites).toBe(false);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["YES", true],
    ["on", true],
    ["0", false],
    ["false", false],
  ])("reads REDDIT_ALLOW_WRITES=%s as %s", (value, expected) => {
    expect(
      loadConfig({ ...base, REDDIT_CLIENT_ID: "c", REDDIT_ALLOW_WRITES: value }).allowWrites,
    ).toBe(expected);
  });

  it("treats an empty env var as unset rather than as an empty value", () => {
    expect(loadConfig({ ...base, REDDIT_CLIENT_ID: "   " }).clientId).toBeUndefined();
  });

  it("refuses REDDIT_ALLOW_WRITES without a client id, since nothing could be posted", () => {
    expect(() => loadConfig({ ...base, REDDIT_ALLOW_WRITES: "1" })).toThrow(/REDDIT_CLIENT_ID/);
  });

  it("ignores an unrelated environment variable", () => {
    // loadConfig maps each env var explicitly, so the schema's .strict() guards
    // the parsed object, not the environment — a typo'd REDDIT_* name is simply
    // not read. The startup banner is what surfaces that: it prints
    // `app=MISSING` rather than letting the server look configured.
    expect(loadConfig({ ...base, REDDIT_CLEINT_ID: "typo" }).clientId).toBeUndefined();
  });

  describe("REDDIT_USER_AGENT", () => {
    it("accepts Reddit's documented format", () => {
      const ua = "macos:mcp-reddit:0.1.0 (by /u/mgcrea)";
      expect(loadConfig({ ...base, REDDIT_USER_AGENT: ua }).userAgent).toBe(ua);
    });

    // Reddit throttles a generic agent regardless of rate limit, so a bad one is
    // caught at startup rather than discovered through mysterious 429s.
    it.each(["mcp-reddit", "Mozilla/5.0", "macos:mcp-reddit:0.1.0"])("rejects %s", (ua) => {
      expect(() => loadConfig({ ...base, REDDIT_USER_AGENT: ua })).toThrow(
        /platform:app-id:version/,
      );
    });
  });
});

describe("effectiveScopes", () => {
  it("never asks for write scopes on a read-only install", () => {
    const scopes = effectiveScopes(loadConfig({ ...base, REDDIT_CLIENT_ID: "c" }));
    for (const write of WRITE_SCOPES) expect(scopes).not.toContain(write);
    expect(scopes).toContain("read");
  });

  it("adds the write scopes when writes are enabled", () => {
    const scopes = effectiveScopes(
      loadConfig({ ...base, REDDIT_CLIENT_ID: "c", REDDIT_ALLOW_WRITES: "1" }),
    );
    expect(scopes).toContain("submit");
    expect(scopes).toContain("vote");
  });
});

describe("setupInstructions", () => {
  it("names the exact redirect URI, because Reddit matches it byte for byte", () => {
    const steps = setupInstructions(loadConfig(base), false).join(" ");
    expect(steps).toContain("http://127.0.0.1:8724/callback");
    expect(steps).toContain("byte for byte");
  });

  it("says anonymous reads already work once a client id exists", () => {
    const steps = setupInstructions(loadConfig({ ...base, REDDIT_CLIENT_ID: "c" }), false).join(
      " ",
    );
    expect(steps).toContain("Anonymous reads work now");
  });

  it("is empty once everything is configured and signed in", () => {
    const config = loadConfig({
      ...base,
      REDDIT_CLIENT_ID: "c",
      REDDIT_USER_AGENT: "macos:mcp-reddit:0.1.0 (by /u/mgcrea)",
    });
    expect(setupInstructions(config, true)).toEqual([]);
  });
});
