import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BUILD_INFO } from "#/build-info";
import { createTokenProvider, type Logger, type TokenProvider } from "#/client/auth";
import { RedditClient } from "#/client/reddit";
import { fileTokenStore, type TokenStore } from "#/client/tokens";
import type { Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;

/**
 * Reddit checks the User-Agent and throttles generic ones regardless of the
 * rate limit, so the configured value wins and this is only the fallback.
 */
export const defaultUserAgent = (): string =>
  `node:mcp-reddit:${BUILD_INFO.version} (by /u/unknown)`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests). */
  tokenProvider?: TokenProvider;
  /** Override where the refresh token lives (tests). */
  store?: TokenStore;
};

export type CreatedServer = {
  server: McpServer;
  client: RedditClient;
  tokens: TokenProvider;
  store: TokenStore;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const store = opts.store ?? fileTokenStore(config.tokenPath);
  const tokens =
    opts.tokenProvider ??
    createTokenProvider({
      config,
      store,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });

  const client = new RedditClient({
    baseUrl: config.baseUrl,
    tokenProvider: tokens,
    maxRetries: config.maxRetries,
    userAgent: config.userAgent ?? defaultUserAgent(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });

  registerTools(server, client, {
    config,
    tokens,
    store,
    allowWrites: config.allowWrites,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return { server, client, tokens, store };
};
