import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * Reddit's OAuth scopes, and what each unlocks here. Requested scopes are
 * computed from the configuration rather than fixed, so a read-only install
 * never asks a user to consent to posting.
 */
export const READ_SCOPES = ["identity", "read", "history", "mysubreddits"] as const;
export const WRITE_SCOPES = [
  "submit",
  "edit",
  "vote",
  "save",
  "subscribe",
  "privatemessages",
] as const;

export const AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
export const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const API_BASE = "https://oauth.reddit.com";

/**
 * A fixed loopback port, deliberately not an ephemeral one. Reddit matches the
 * callback against the URI registered on the app preferences page byte for
 * byte, so a random port can never be authorized.
 */
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8724/callback";

const ConfigSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    /** Empty for an "installed app"; set for a "web app" / "script" app. */
    clientSecret: z.string().min(1).optional(),
    redirectUri: z.url().default(DEFAULT_REDIRECT_URI),
    /**
     * Reddit rejects or throttles a generic User-Agent regardless of rate
     * limit, and the format is documented, so it is validated here rather than
     * discovered through mysterious 429s.
     */
    userAgent: z
      .string()
      .regex(
        /^[^:]+:[^:]+:[^ ]+ \(by \/u\/[A-Za-z0-9_-]+\)$/,
        "REDDIT_USER_AGENT must look like `platform:app-id:version (by /u/username)`, " +
          "e.g. `macos:mcp-reddit:0.1.0 (by /u/mgcrea)`. Reddit throttles generic agents.",
      )
      .optional(),
    /** Anonymous app-only reads when no user has logged in. */
    deviceId: z.string().min(20).max(40).default("DO_NOT_TRACK_THIS_DEVICE"),
    tokenPath: z.string().min(1),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    /** Refresh the access token this many seconds before it expires. */
    refreshSkewSeconds: z.number().int().nonnegative().max(600).default(60),
    httpPort: z.number().int().min(1).max(65535).default(8725),
    baseUrl: z.url().default(API_BASE),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    // Deliberately NOT an error when clientId is missing. An MCP server that
    // exits on startup shows up in the client as a bare "Connection closed",
    // with stderr swallowed — so the one message that would have explained the
    // problem never reaches anyone. reddit_auth_status reports it instead.
    if (cfg.allowWrites && !cfg.clientId) {
      ctx.addIssue({
        code: "custom",
        path: ["clientId"],
        message: "REDDIT_ALLOW_WRITES is set but REDDIT_CLIENT_ID is not — nothing can be posted.",
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/** Where the refresh token lives. XDG-respecting, overridable for tests. */
export const resolveTokenPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.REDDIT_TOKEN_PATH);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "reddit", "tokens.json");
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config =>
  ConfigSchema.parse({
    clientId: trimmed(env.REDDIT_CLIENT_ID),
    clientSecret: trimmed(env.REDDIT_CLIENT_SECRET),
    redirectUri: trimmed(env.REDDIT_REDIRECT_URI),
    userAgent: trimmed(env.REDDIT_USER_AGENT),
    deviceId: trimmed(env.REDDIT_DEVICE_ID),
    tokenPath: resolveTokenPath(env),
    allowWrites: parseBool(env.REDDIT_ALLOW_WRITES),
    maxRetries: parseIntOpt(env.REDDIT_MAX_RETRIES),
    refreshSkewSeconds: parseIntOpt(env.REDDIT_REFRESH_SKEW_SECONDS),
    httpPort: parseIntOpt(env.REDDIT_HTTP_PORT),
    baseUrl: trimmed(env.REDDIT_API_URL),
  });

/** The scopes this configuration actually needs, so a reader never consents to writes. */
export const effectiveScopes = (config: Config): string[] =>
  config.allowWrites ? [...READ_SCOPES, ...WRITE_SCOPES] : [...READ_SCOPES];

/**
 * Returned by reddit_auth_status and printed to stderr at startup. Prose rather
 * than a code, because this is the text someone acts on when nothing works.
 */
export const setupInstructions = (config: Config, loggedIn: boolean): string[] => {
  const steps: string[] = [];
  if (!config.clientId) {
    steps.push(
      "Create an app at https://www.reddit.com/prefs/apps — pick 'installed app' for the " +
        "browser login flow, or 'script' if you only want anonymous reads.",
      `Set the redirect URI on that page to exactly ${config.redirectUri}. Reddit matches it byte for byte.`,
      "Set REDDIT_CLIENT_ID (and REDDIT_CLIENT_SECRET for a web/script app), then restart.",
    );
  }
  if (!config.userAgent) {
    steps.push(
      "Set REDDIT_USER_AGENT to `platform:app-id:version (by /u/yourname)`. Reddit throttles " +
        "generic user agents regardless of your rate limit.",
    );
  }
  if (config.clientId && !loggedIn) {
    steps.push(
      "Anonymous reads work now. Call reddit_auth_login to sign in for your subscriptions, " +
        "saved posts, inbox and (with REDDIT_ALLOW_WRITES=1) posting.",
    );
  }
  return steps;
};
