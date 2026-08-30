import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";

import { postToken, type Logger, type TokenResponse } from "#/client/auth";
import { TOKEN_FILE_VERSION, type TokenStore } from "#/client/tokens";
import type { Config } from "#/config";
import { AUTHORIZE_URL, effectiveScopes } from "#/config";

/** An abandoned login must not leave the callback port bound forever. */
const CALLBACK_TIMEOUT_MS = 180_000;

const base64url = (buf: Buffer): string =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type PkcePair = { verifier: string; challenge: string };

/**
 * PKCE S256. 32 random bytes base64url-encode to exactly 43 characters, the
 * minimum the spec allows for a verifier.
 */
export const createPkcePair = (random: (n: number) => Buffer = randomBytes): PkcePair => {
  const verifier = base64url(random(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
};

export const buildAuthorizeUrl = (opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  challenge: string;
}): string => {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    state: opts.state,
    redirect_uri: opts.redirectUri,
    // Without duration=permanent Reddit issues an access token and NO refresh
    // token, so the login silently lasts one hour and then stops working.
    duration: "permanent",
    // Reddit separates scopes with spaces here, unlike the commas it uses for
    // almost every other list in its API.
    scope: opts.scopes.join(" "),
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
};

/** Constant-time compare, so a mismatched state cannot be probed byte by byte. */
export const statesMatch = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Verify a PKCE `code_verifier` against the `code_challenge` recorded at
 * /authorize (S256 only — `plain` is not accepted). Constant-time, because a
 * verifier that can be probed byte by byte is not a verifier.
 */
export const verifyPkceS256 = (verifier: string, challenge: string): boolean =>
  statesMatch(base64url(createHash("sha256").update(verifier).digest()), challenge);

export const exchangeCode = async (
  config: Config,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> =>
  postToken(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
    fetchImpl,
  );

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem"><h1>${title}</h1><p>${body}</p></body>`;

export type LoginResult = {
  scopes: string[];
  username?: string;
};

export type LoginOptions = {
  config: Config;
  store: TokenStore;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Called with the authorize URL; the default opens a browser. */
  open?: (url: string) => void;
  timeoutMs?: number;
};

/**
 * Run the loopback half of the PKCE flow: bind the callback port, hand the user
 * the authorize URL, wait for Reddit to redirect back, exchange the code and
 * persist the refresh token.
 *
 * The listener binds 127.0.0.1 explicitly. Without a host argument Node binds
 * every interface, which would put an authorization code — briefly, but really —
 * on the LAN.
 */
export const runLoopbackLogin = async (opts: LoginOptions): Promise<LoginResult> => {
  const { config, store } = opts;
  if (!config.clientId) {
    throw new Error(
      "REDDIT_CLIENT_ID is not set. Create an app at https://www.reddit.com/prefs/apps first.",
    );
  }
  const fetchImpl = opts.fetch ?? fetch;
  const redirect = new URL(config.redirectUri);
  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(24));
  const scopes = effectiveScopes(config);
  const url = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes,
    state,
    challenge,
  });

  const received = new Promise<string>((resolve, reject) => {
    const server = createHttpServer((req, res) => {
      const incoming = new URL(req.url ?? "/", `http://127.0.0.1:${redirect.port}`);
      if (incoming.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const error = incoming.searchParams.get("error");
      const code = incoming.searchParams.get("code");
      const returnedState = incoming.searchParams.get("state") ?? "";

      const finish = (status: number, html: string, err?: Error, value?: string): void => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html);
        server.close();
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value as string);
      };

      if (error) {
        finish(
          400,
          page("Login failed", `Reddit said: ${error}`),
          new Error(`Reddit denied the login: ${error}`),
        );
        return;
      }
      if (!statesMatch(returnedState, state)) {
        finish(
          400,
          page("Login failed", "State mismatch."),
          new Error(
            "OAuth state mismatch — the callback did not come from the login this server started.",
          ),
        );
        return;
      }
      if (!code) {
        finish(
          400,
          page("Login failed", "No code in the callback."),
          new Error("Reddit's callback carried no authorization code."),
        );
        return;
      }
      finish(
        200,
        page("Signed in", "You can close this tab and go back to your editor."),
        undefined,
        code,
      );
    });

    const timer = setTimeout(() => {
      server.close();
      reject(
        new Error(
          `Timed out after ${(opts.timeoutMs ?? CALLBACK_TIMEOUT_MS) / 1000}s waiting for the Reddit callback.`,
        ),
      );
    }, opts.timeoutMs ?? CALLBACK_TIMEOUT_MS);
    // Do not hold the process open just for the callback listener.
    timer.unref?.();

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Could not bind ${config.redirectUri}: ${err.message}. ` +
            `The port is fixed because Reddit matches the redirect URI byte for byte.`,
        ),
      );
    });
    server.listen(Number(redirect.port), "127.0.0.1");
  });

  opts.open?.(url);
  const code = await received;
  const tokens = await exchangeCode(config, code, verifier, fetchImpl);
  if (!tokens.refresh_token) {
    throw new Error(
      "Reddit returned no refresh token. That happens when the authorize URL omits " +
        "`duration=permanent`, or when the app is a 'script' type rather than 'installed app'.",
    );
  }

  const granted = tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : scopes;
  store.write({
    version: TOKEN_FILE_VERSION,
    refreshToken: tokens.refresh_token,
    scopes: granted,
    obtainedAt: Math.floor(Date.now() / 1000),
  });
  return { scopes: granted };
};
