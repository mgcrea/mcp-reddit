# @mgcrea/mcp-reddit

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Reddit API** —
browsing, search, comment threads, user history, and (opt-in) posting.

The server is **read-only by default**. Mutating tools are not merely refused when writes are
off — they are never registered, so an agent cannot call them at all.

## Features

- **Works before you log in.** Reddit's anonymous installed-client grant covers subreddits,
  posts, comments and search, so a client id alone gets you most of this server.
- **Browser login as a tool.** `reddit_auth_login` opens Reddit's consent page and catches the
  callback on a loopback port — no CLI step, no password anywhere.
- **Comment trees are flattened and bounded.** They are the single biggest context-window risk
  in this API; `maxDepth` and `maxComments` are low by default and unexpanded replies are
  _reported_, not silently dropped.
- **Responses are shaped.** A Reddit post carries ~110 fields, most of them null or UI state.
  List tools return the dozen that matter plus the pagination cursor.
- **Rate limits surfaced.** Reddit reports its budget on every response; a 429 here quotes the
  actual window rather than telling you to try again later.
- **Two transports.** stdio for the usual case; Streamable HTTP with a full OAuth authorization
  server when you want Claude Code's Authenticate button.
- Native `fetch`, no runtime dependencies beyond the MCP SDK and Zod (plus `express` in HTTP
  mode, which the SDK already depends on).

## Security

- **Read-only by default.** `REDDIT_ALLOW_WRITES=1` adds the write tools; the destructive ones
  (`reddit_delete`, `reddit_edit`) and everything that publishes additionally require an
  explicit `confirm: true` on every call.
- **Scopes are computed, not fixed.** A read-only install never asks you to consent to posting
  or voting. Turning writes on requires logging in again, deliberately.
- **Your refresh token** is written mode `0600` to `~/.config/reddit/tokens.json` and never
  leaves this machine. In HTTP mode it never leaves the process — the MCP client gets an opaque
  local token instead.
- **HTTP mode binds `127.0.0.1` explicitly**, caps request bodies, validates `Host` and
  `Origin`, and sets header/request timeouts.
- Reddit's API terms forbid automated vote manipulation, and unsolicited private messages are
  the fastest route to a suspended account. `reddit_vote` and `reddit_send_message` both say so
  in their descriptions, and both require `confirm`.

## Configure

Create an app at <https://www.reddit.com/prefs/apps> — **installed app** for the login flow
(no secret), or **script** for anonymous reads only.

| Variable               | Required    | Description                                                                                                                           |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `REDDIT_CLIENT_ID`     | yes         | From the app page. Without it only the auth tools are registered.                                                                     |
| `REDDIT_CLIENT_SECRET` | web/script  | Leave unset for an installed app.                                                                                                     |
| `REDDIT_USER_AGENT`    | in practice | `platform:app-id:version (by /u/name)`. Reddit throttles generic agents regardless of rate limit; the format is validated at startup. |
| `REDDIT_ALLOW_WRITES`  | no          | `1` to register the mutating tools.                                                                                                   |
| `REDDIT_REDIRECT_URI`  | no          | Defaults to `http://127.0.0.1:8724/callback`. **Must match the app page byte for byte.**                                              |
| `REDDIT_TOKEN_PATH`    | no          | Defaults to `$XDG_CONFIG_HOME/reddit/tokens.json`.                                                                                    |
| `REDDIT_HTTP_PORT`     | no          | Port for HTTP mode. Defaults to 8725.                                                                                                 |
| `REDDIT_MAX_RETRIES`   | no          | Retry budget for 401/429/5xx. Defaults to 3.                                                                                          |
| `REDDIT_DEBUG`         | no          | `1` to log to stderr.                                                                                                                 |

```bash
cp .env.example .env
```

## Quick start

```bash
pnpm install
pnpm build
```

Copy `.mcp.json.example` to `.mcp.json`, fill in the client id, restart your client, then:

> log me into Reddit

which calls `reddit_auth_login`, opens the browser, and stores a refresh token. Restart the
server afterwards to pick up the account-scoped tools.

### Inspect the tools

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
| REDDIT_CLIENT_ID=x node dist/cli.js 2>/dev/null | jq -r '.result.tools[]?.name'
```

## Tools

Always registered, even with nothing configured:

| Tool                 | What it does                                                         | Writes     |
| -------------------- | -------------------------------------------------------------------- | ---------- |
| `reddit_auth_status` | Credential state, active scopes, and what to set or run next         | no         |
| `reddit_auth_login`  | Browser login; stores a refresh token                                | local only |
| `reddit_auth_logout` | Forget the stored token                                              | local only |
| `reddit_auth_url`    | Build the consent URL without listening (browser on another machine) | no         |

With a client id (anonymous reads work here — no login needed):

| Tool                        | What it does                                                         | Writes |
| --------------------------- | -------------------------------------------------------------------- | ------ |
| `reddit_list_posts`         | Posts from a subreddit or the front page, by hot/new/top/rising      | no     |
| `reddit_get_subreddit`      | One subreddit's description, subscribers, active users               | no     |
| `reddit_search`             | Search one subreddit or all of Reddit                                | no     |
| `reddit_get_post`           | One post plus its comment thread, flattened and bounded              | no     |
| `reddit_get_more_comments`  | Expand the reply stubs `reddit_get_post` reported                    | no     |
| `reddit_get_user`           | An account's karma, age and flags                                    | no     |
| `reddit_list_user_posts`    | What an account submitted                                            | no     |
| `reddit_list_user_comments` | What an account commented                                            | no     |
| `reddit_request`            | Escape hatch for unwrapped endpoints (GET-only unless writes are on) | gated  |
| `reddit_rate_limit_status`  | What Reddit has said about your remaining budget                     | no     |

After `reddit_auth_login`:

| Tool                        | What it does                           | Writes |
| --------------------------- | -------------------------------------- | ------ |
| `reddit_get_me`             | Which account this server is acting as | no     |
| `reddit_list_subscriptions` | Subreddits you subscribe to            | no     |
| `reddit_get_saved`          | Your saved posts and comments          | no     |
| `reddit_get_inbox`          | Messages, replies and mentions         | no     |

With `REDDIT_ALLOW_WRITES=1` **and** a login:

| Tool                  | What it does                                   | Confirm |
| --------------------- | ---------------------------------------------- | ------- |
| `reddit_submit_post`  | Submit a self or link post                     | yes     |
| `reddit_reply`        | Reply to a post or comment                     | yes     |
| `reddit_vote`         | Up/down/clear a vote                           | yes     |
| `reddit_save`         | Save or unsave                                 | no      |
| `reddit_subscribe`    | Join or leave a subreddit                      | no      |
| `reddit_send_message` | Send a private message                         | yes     |
| `reddit_edit`         | Edit your own post or comment                  | yes     |
| `reddit_delete`       | Delete your own post or comment — irreversible | yes     |

## Reading a thread without blowing the context window

The default path:

```
reddit_search      query="borrow checker" subreddit=rust sort=relevance t=all
reddit_get_post    postId=<id from the search>
```

`reddit_get_post` returns at most 50 comments, three levels deep. Anything it did not walk comes
back under `unexpanded`:

```json
{
  "post": { "id": "t3_1abc2de", "title": "…", "score": 412 },
  "comments": [{ "id": "t1_x", "depth": 0, "body": "…" }],
  "unexpanded": [{ "parent": "t1_x", "count": 87, "ids": ["abc", "def"] }]
}
```

Pass those ids to `reddit_get_more_comments`. Re-fetching the post with a larger `maxDepth`
walks the same top-level branches again rather than continuing where it stopped — that is what
the stubs are for.

## Claude Code's Authenticate button (HTTP mode)

The Authenticate button only exists for HTTP-transport servers: OAuth in MCP is defined for HTTP
transports, and a stdio server takes its credentials from the environment. `reddit_auth_login`
is the stdio equivalent and is simpler. If you want the button:

```bash
pnpm dev:http     # or: node dist/http.js
claude mcp add --transport http reddit http://127.0.0.1:8725/mcp
```

Register the callback the server prints at startup — `http://127.0.0.1:8725/oauth/callback` —
as the redirect URI on your Reddit app page.

**Why this needs a real authorization server rather than the SDK's proxy provider.**
`ProxyOAuthServerProvider` forwards the _client's_ `redirect_uri` upstream. Reddit matches
`redirect_uri` byte for byte against the one value on the app page, and Claude Code picks its
loopback callback port dynamically, so the proxy's redirect is rejected every time — and Reddit
has no dynamic client registration to fall back on. So this server is its own authorization
server and hides the Reddit leg:

```
Claude Code → /authorize → (browser) → Reddit consent
                                          ↓
Claude Code ← /oauth/callback?code=ours ← our fixed registered callback
Claude Code → /token → our opaque token, mapped to the stored Reddit refresh token
```

The Reddit refresh token never leaves this process. Claude Code stores its own token in the
macOS keychain and refreshes it automatically.

Trade-offs: the server has to already be running (an HTTP server is not spawned by the client),
and it is loopback-only by design. The upside beyond the button is that an HTTP server can be
restarted underneath a live client, so `pnpm dev:http` gives an edit→reload loop without
reloading the editor window.

## Traps worth knowing

- **`duration=permanent` or no refresh token.** Omit it and Reddit issues an access token only;
  the login silently stops working after an hour.
- **The redirect URI is matched byte for byte**, which is why the loopback port is fixed rather
  than ephemeral.
- **`client_id:` with the trailing colon.** An installed app has no secret, and Reddit rejects
  Basic auth without the empty password.
- **Write endpoints answer HTTP 200 when the action failed.** The real result is in
  `json.errors`; a 2xx is not success. Handled centrally in `client/reddit.ts`.
- **Reddit takes form encoding on writes**, never JSON.
- **User listings stop at ~1000 items** however far you paginate, so a prolific account's full
  history is not reachable.
- **404 means banned as well as missing.** A quarantined or banned subreddit is indistinguishable
  from a typo.
- **Scopes are space-separated** in the authorize URL, unlike the commas Reddit uses for almost
  every other list.

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm dev:http       # HTTP transport with hot reload
pnpm test           # vitest
pnpm typecheck
pnpm lint
pnpm format
```

Tests run offline against a mocked `fetch` — no credentials, no network. The registration
matrix is asserted with `toEqual`, so adding a tool is always a deliberate change.

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm + GHCR from the tag
```

## License

MIT
