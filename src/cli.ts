#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ZodError } from "zod";

import { BUILD_INFO } from "./build-info.js";
import { loadConfig, setupInstructions } from "./config.js";
import { createServer } from "./server.js";

// Everything goes to stderr: stdout is the MCP protocol channel, and a stray
// log line there corrupts the stream.
const stderrLogger = {
  debug: (...args: unknown[]) => {
    if (process.env.REDDIT_DEBUG) console.error("[reddit-mcp]", ...args);
  },
  warn: (...args: unknown[]) => console.error("[reddit-mcp]", ...args),
  error: (...args: unknown[]) => console.error("[reddit-mcp]", ...args),
};

/** Show a config mistake as its field messages, not 40 frames of zod internals. */
const describeFatal = (err: unknown): string => {
  if (err instanceof ZodError) {
    return err.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("\n");
  }
  return err instanceof Error ? err.message : String(err);
};

const main = async (): Promise<void> => {
  stderrLogger.warn(
    `${BUILD_INFO.name}@${BUILD_INFO.version} (git ${BUILD_INFO.gitCommit} ${BUILD_INFO.gitCommitDate}, node ${process.version})`,
  );
  const config = loadConfig();
  const { server, tokens } = createServer({ config, logger: stderrLogger });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The banner is the diagnostic surface: this scrolling past is the last chance
  // anyone has to notice `writes=ENABLED` before an agent posts something.
  stderrLogger.warn(
    `reddit-mcp connected (app=${config.clientId ? "configured" : "MISSING"}, ` +
      `account=${tokens.hasUser() ? "signed in" : "anonymous"}, ` +
      `writes=${config.allowWrites ? "ENABLED" : "disabled"}, ` +
      `ua=${config.userAgent ? "set" : "DEFAULT (will be throttled)"})`,
  );
  for (const line of setupInstructions(config, tokens.hasUser())) stderrLogger.warn(`  ${line}`);

  const shutdown = (signal: string): void => {
    stderrLogger.warn(`received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

main().catch((err: unknown) => {
  console.error(`[reddit-mcp] fatal: ${describeFatal(err)}`);
  process.exit(1);
});
