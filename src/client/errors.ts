export class RedditApiError extends Error {
  override readonly name = "RedditApiError";
  readonly status: number;
  readonly errors: unknown;
  /** From `x-ratelimit-*`, when the failure was a 429. */
  readonly rateLimit: { remaining?: number; used?: number; resetSeconds?: number } | undefined;

  constructor(
    message: string,
    opts: {
      status: number;
      errors?: unknown;
      rateLimit?: { remaining?: number; used?: number; resetSeconds?: number } | undefined;
    },
  ) {
    super(message);
    this.status = opts.status;
    this.errors = opts.errors;
    this.rateLimit = opts.rateLimit;
  }
}

/** Thrown when a write path is reached while REDDIT_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. Set REDDIT_ALLOW_WRITES=1 to ` +
        `register the mutating tools. You will also need to run reddit_auth_login again, ` +
        `because a read-only login never asked Reddit for the submit/vote scopes.`,
    );
  }
}

/**
 * Thrown when a tool needs a signed-in user but only the anonymous app-only
 * token is available — subscriptions, saved posts, the inbox, anything writing.
 */
export class UserContextRequiredError extends Error {
  override readonly name = "UserContextRequiredError";

  constructor(what: string) {
    super(
      `${what} needs a signed-in Reddit account, but this server is using the anonymous ` +
        `app-only token. Call reddit_auth_login first.`,
    );
  }
}

/**
 * Reddit's own error envelope. The `/api/*` write endpoints answer HTTP 200 with
 * `{json: {errors: [["BAD_CAPTCHA", "...", "field"]]}}`, so a successful request
 * is not a successful action and the two have to be separated.
 */
export class RedditActionError extends Error {
  override readonly name = "RedditActionError";
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}
