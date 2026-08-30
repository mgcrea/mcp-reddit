import type { McpServer } from "@modelcontextprotocol/server";

import type { TokenProvider } from "#/client/auth";
import type { RedditClient } from "#/client/reddit";
import type { TokenStore } from "#/client/tokens";
import type { Config } from "#/config";
import { registerAccountTools } from "#/tools/account";
import { registerAuthTools } from "#/tools/auth";
import { registerBrowseTools } from "#/tools/browse";
import { registerRequestTool } from "#/tools/request";
import { registerUserTools } from "#/tools/users";
import { registerWriteTools } from "#/tools/write";

export type ToolContext = {
  config: Config;
  tokens: TokenProvider;
  store: TokenStore;
  /** Register the mutating tools too. Off by default — see REDDIT_ALLOW_WRITES. */
  allowWrites: boolean;
  /** Injected in tests so the login flow never touches the network. */
  fetch?: typeof fetch;
};

/**
 * Registration is a three-step ladder, and each step is a real capability
 * boundary rather than a policy check.
 *
 * 1. Auth tools always, even with nothing configured. A server that exits when
 *    credentials are missing shows up in the client as a bare "Connection
 *    closed" with stderr swallowed, so the one message explaining what to set
 *    never reaches anyone. reddit_auth_status is that message, as a tool.
 * 2. Public browsing as soon as a client id exists — Reddit's anonymous
 *    installed-client grant covers subreddits, posts, comments and search, so
 *    most of this server works before anybody logs in.
 * 3. Account and write tools only with a real login. They are absent rather
 *    than refused, so an agent cannot call them at all.
 */
export const registerTools = (server: McpServer, client: RedditClient, ctx: ToolContext): void => {
  registerAuthTools(server, ctx);

  if (!ctx.config.clientId) return;

  registerBrowseTools(server, client, ctx);
  registerUserTools(server, client, ctx);
  registerRequestTool(server, client, ctx);

  if (!ctx.tokens.hasUser()) return;

  registerAccountTools(server, client, ctx);
  if (ctx.allowWrites) registerWriteTools(server, client, ctx);
};
