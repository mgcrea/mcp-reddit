import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { basicAuth, createTokenProvider } from "#/client/auth";
import { buildAuthorizeUrl, createPkcePair, statesMatch } from "#/client/oauth";
import { fileTokenStore, memoryTokenStore, TOKEN_FILE_VERSION } from "#/client/tokens";
import { loadConfig } from "#/config";

const base = { REDDIT_TOKEN_PATH: "/nonexistent/tokens.json", REDDIT_CLIENT_ID: "cid" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("PKCE", () => {
  it("produces a 43-character S256 verifier, the spec minimum", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces a different pair every time", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe("statesMatch", () => {
  it("matches an identical state and rejects anything else", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    // Different lengths must not throw — timingSafeEqual does, if given them.
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch("", "")).toBe(true);
  });
});

describe("buildAuthorizeUrl", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:8724/callback",
      scopes: ["identity", "read"],
      state: "st",
      challenge: "ch",
    }),
  );

  it("asks for a permanent grant, without which Reddit returns no refresh token", () => {
    expect(url.searchParams.get("duration")).toBe("permanent");
  });

  it("separates scopes with spaces, not the commas Reddit uses elsewhere", () => {
    expect(url.searchParams.get("scope")).toBe("identity read");
  });

  it("sends the PKCE challenge with the S256 method", () => {
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("basicAuth", () => {
  it("keeps the trailing colon for an installed app with no secret", () => {
    // `client_id:` not `client_id` — Reddit rejects the latter.
    const header = basicAuth(loadConfig(base));
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("cid:");
  });

  it("includes the secret for a web or script app", () => {
    const header = basicAuth(loadConfig({ ...base, REDDIT_CLIENT_SECRET: "shh" }));
    expect(Buffer.from(header.replace("Basic ", ""), "base64").toString()).toBe("cid:shh");
  });
});

describe("token provider", () => {
  const config = loadConfig(base);

  it("mints the anonymous installed-client token when nobody is signed in", async () => {
    const fetchMock = vi.fn(async () => json({ access_token: "app-tok", expires_in: 3600 }));
    const tokens = createTokenProvider({
      config,
      store: memoryTokenStore(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await tokens.getToken("app")).toBe("app-tok");
    const body = String((fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1].body);
    expect(body).toContain("installed_client");
    expect(tokens.hasUser()).toBe(false);
  });

  it("caches the token rather than minting one per request", async () => {
    const fetchMock = vi.fn(async () => json({ access_token: "app-tok", expires_in: 3600 }));
    const tokens = createTokenProvider({
      config,
      store: memoryTokenStore(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    await tokens.getToken("app");
    await tokens.getToken("app");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints after invalidate, which is what the 401 retry path calls", async () => {
    const fetchMock = vi.fn(async () => json({ access_token: "app-tok", expires_in: 3600 }));
    const tokens = createTokenProvider({
      config,
      store: memoryTokenStore(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    await tokens.getToken("app");
    tokens.invalidate("app");
    await tokens.getToken("app");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clamps the refresh skew to half a short-lived token's life", async () => {
    // A 60s skew against a 60s token would treat it as expired on arrival.
    let now = 1_000_000;
    const fetchMock = vi.fn(async () => json({ access_token: "short", expires_in: 60 }));
    const tokens = createTokenProvider({
      config,
      store: memoryTokenStore(),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    await tokens.getToken("app");
    now += 25_000;
    await tokens.getToken("app");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tells the caller to log in rather than failing with a confusing 403", async () => {
    const tokens = createTokenProvider({
      config,
      store: memoryTokenStore(),
      fetch: vi.fn() as unknown as typeof fetch,
    });
    await expect(tokens.getToken("user")).rejects.toThrow(/reddit_auth_login/);
  });

  it("persists a rotated refresh token, or the next refresh uses a retired one", async () => {
    const store = memoryTokenStore({
      version: TOKEN_FILE_VERSION,
      refreshToken: "old",
      scopes: ["read"],
      obtainedAt: 0,
    });
    const fetchMock = vi.fn(async () =>
      json({ access_token: "user-tok", expires_in: 3600, refresh_token: "rotated" }),
    );
    const tokens = createTokenProvider({
      config,
      store,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await tokens.getToken("user");
    expect(store.read()?.refreshToken).toBe("rotated");
  });

  it("blames the app credentials on a 401, not the user's login", async () => {
    const fetchMock = vi.fn(async () => json({ error: "invalid_client" }, 401));
    const tokens = createTokenProvider({
      config,
      store: memoryTokenStore(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(tokens.getToken("app")).rejects.toThrow(/REDDIT_CLIENT_ID/);
  });
});

const tmp = (): string => join(mkdtempSync(join(tmpdir(), "mcp-reddit-")), "tokens.json");

describe("file token store", () => {
  it("round-trips a refresh token", () => {
    const path = tmp();
    const store = fileTokenStore(path);
    store.write({
      version: TOKEN_FILE_VERSION,
      refreshToken: "r",
      scopes: ["read"],
      obtainedAt: 1,
    });
    expect(store.read()?.refreshToken).toBe("r");
  });

  it("creates the file 0600, because it holds a long-lived account credential", () => {
    const path = tmp();
    fileTokenStore(path).write({
      version: TOKEN_FILE_VERSION,
      refreshToken: "r",
      scopes: [],
      obtainedAt: 1,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads as signed-out when the file was written by another format version", () => {
    const path = tmp();
    writeFileSync(
      path,
      JSON.stringify({ version: TOKEN_FILE_VERSION + 1, refreshToken: "future" }),
    );
    expect(fileTokenStore(path).read()).toBeUndefined();
  });

  it("reads as signed-out on a missing or corrupt file rather than throwing", () => {
    expect(fileTokenStore("/nonexistent/tokens.json").read()).toBeUndefined();
    const path = tmp();
    writeFileSync(path, "{ not json");
    expect(fileTokenStore(path).read()).toBeUndefined();
  });

  it("clear() is a no-op when nothing was stored", () => {
    expect(() => fileTokenStore("/nonexistent/tokens.json").clear()).not.toThrow();
  });
});
