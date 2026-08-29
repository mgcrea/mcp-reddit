import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Bumped if the on-disk shape ever changes, so an old file is discarded rather than misread. */
export const TOKEN_FILE_VERSION = 1;

export type StoredTokens = {
  version: number;
  refreshToken: string;
  scopes: string[];
  /** Epoch seconds when the account was authorized. Informational. */
  obtainedAt: number;
  username?: string;
};

export type TokenStore = {
  read(): StoredTokens | undefined;
  write(tokens: StoredTokens): void;
  clear(): void;
};

/**
 * A refresh token is a long-lived credential for a real account, so the file is
 * created 0600 and the directory 0700. `writeFileSync`'s mode only applies when
 * the file is created, so chmod runs unconditionally afterwards.
 */
export const fileTokenStore = (path: string): TokenStore => ({
  read: () => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredTokens;
      if (parsed.version !== TOKEN_FILE_VERSION) return undefined;
      return parsed.refreshToken ? parsed : undefined;
    } catch {
      return undefined;
    }
  },
  write: (tokens) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  },
  clear: () => {
    try {
      rmSync(path);
    } catch {
      /* already gone */
    }
  },
});

/** For tests: keeps the tokens in memory, touching no filesystem. */
export const memoryTokenStore = (initial?: StoredTokens): TokenStore => {
  let held = initial;
  return {
    read: () => held,
    write: (tokens) => {
      held = tokens;
    },
    clear: () => {
      held = undefined;
    },
  };
};
