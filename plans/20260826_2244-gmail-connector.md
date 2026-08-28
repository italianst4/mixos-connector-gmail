# Gmail connector — read-only, one shared mailbox

## Context

We want MixOS apps to be able to read email. The request as phrased was "so that
users can access their emails", which on this platform is not buildable as
stated: connectors are **tenant-scoped**. One credential set is configured once
by an admin and shared by every user, and the per-user OAuth model — the
`user_connector_oauth` table, the `/account/connections` page, the
`OAuthCapableConnector` interface, the `scope` manifest field — was deliberately
removed and is documented as staying removed
([`docs/connectors/architecture.md`](../../../docs/connectors/architecture.md)
"One credential set per connector").

So this connector reads **one** mailbox — a shared `support@` / `alerts@` / team
inbox that an admin connects on behalf of the whole deployment. Everyone sees
the same inbox. That is the useful, honest version of the request, and it needs
zero changes below `connectors/`.

The two alternatives were considered and rejected for v1, both because they are
platform plans rather than connector work:

- **Per-user inboxes** — reintroducing per-user OAuth into `src/lib/connectors/`
  reverses an explicit architectural decision and adds a per-user token store.
- **Workspace domain-wide delegation** — one service-account key impersonating
  any user in the domain would give per-user reads from a single tenant
  credential, but Google's service-account flow is a signed
  `urn:ietf:params:oauth:grant-type:jwt-bearer` assertion, and the base layer
  supports exactly five strategies, none of which is JWT-bearer
  ([`types.ts:55-60`](../../../src/lib/connectors/types.ts#L55-L60)).

If per-user access is wanted later, it is a `docs/plans/` platform plan and this
connector is unaffected by it.

## Decisions

Locked with the user:

| Decision | Choice | Consequence |
| --- | --- | --- |
| Whose mailbox | One shared mailbox, admin-connected | Fits the tenant-scoped model as built; no `src/` changes |
| Access level | Read-only | Single scope `gmail.readonly`; no method mutates, so `telemetry[].mutates` is absent everywhere and MCP read-only tools can call all of it |
| Operations | Search/list, get message with decoded body, threads, labels, attachments | Six public methods |
| Google account | Workspace, **Internal** OAuth app | Restricted Gmail scopes work immediately — no Google app verification, no annual CASA assessment, no 7-day refresh-token expiry |

Decisions made during the read of the base layer, each with the evidence:

### 1. `access_type=offline` rides in `authorizeUrl`'s query string

[`buildAuthorizeUrl`](../../../src/lib/connectors/oauth.ts#L144-L160) sends only
`response_type`, `client_id`, `redirect_uri`, `state`, `code_challenge`,
`code_challenge_method`, `scope`. Google returns a refresh token **only** when
`access_type=offline` is present, and reliably re-issues one only with
`prompt=consent`. Without a refresh token the grant dies in ~1 hour and the
admin has to press Connect again, forever.

`buildAuthorizeUrl` does `new URL(policy.authorizeUrl)` and then
`searchParams.set(...)`, which **preserves** any query string already on the
declared URL, and the manifest schema validates `authorizeUrl` with `z.url()`
([`manifest-schemas.ts:574`](../../../scripts/manifest-schemas.ts#L574)), which
accepts one. So:

```
"authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent"
```

This is the whole fix, and it needs no platform change. **It is also the single
thing most likely to be wrong**, so verification below proves a refresh token
actually comes back rather than assuming it.

### 2. `rateLimitOn403` is deliberately **not** set

Gmail signals throttling with both `429` and `403 rateLimitExceeded` /
`userRateLimitExceeded`, so `http.rateLimitOn403: true` looks correct. It is
not. [`classifyStatus`](../../../src/lib/connectors/status-map.ts#L73-L77) makes
that flag classify **every** 403 as retryable `rate_limited` — including
`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, which is the single most likely 403 here
given restricted scopes. That would turn "the admin approved the wrong scope"
into three pointless retries and a permanent "rate limited, try again later",
with no Registry hint and a Retry button that can never work.

Omitting the flag classifies a scope failure as `forbidden` — which
[`ConnectorErrorState`](../../../src/components/connectors/connector-error-state.tsx)
renders as **"Not connected"** with no Retry button, which is exactly right.
A 403 that is a *genuine* throttle still classifies as `rate_limited` anyway,
because `throttled` is true whenever `Retry-After` or an exhausted
`X-RateLimit-Remaining` is present, and that check runs before the flag.

Cost of the choice: a 403 throttle carrying no `Retry-After` header is not
retried. Mitigated by decision 4 (bounded, sequential hydration).

### 3. `listMessages` does not use `this.paginate()`

Gmail's `users.messages.list` **omits the `messages` key entirely** when nothing
matches, returning `{"resultSizeEstimate": 0}`. `paginate()` resolves
`itemsPath`, finds `undefined`, and throws `unexpected_response`
([`http-connector.ts:480-487`](../../../src/lib/connectors/http-connector.ts#L480-L487)).
An empty inbox or a search with no hits would surface to the user as "the
upstream API changed".

So `listMessages` runs its own bounded `pageToken` loop over `this.request()`.
This is not the hand-rolled-loop anti-pattern: the anti-patterns are calling
`fetch` directly and hand-rolling *retry*/backoff/auth, all of which still come
from `request()`. No `http.pagination` block is declared, since declaring one we
never use would be a lie about the connector's behaviour.

Fixing `paginate()` to treat a missing `itemsPath` as an empty page is a
reasonable platform change, but it is a `docs/plans/` change and does not block
this connector.

### 4. Hydration is bounded and sequential

Gmail list returns only `{id, threadId}`; the headers and body need one `get`
per message. Reading a list therefore costs N+1 calls. Rather than a `hydrate` flag on
`listMessages` — which would make its return type a union and hide the cost —
hydration is a separate `searchMessages`, capped at `MAX_HYDRATE = 25` per
call and issued sequentially. A widget therefore cannot fan 100 concurrent
requests at Gmail's per-user quota (250 units/sec) and trip the un-retried 403
from decision 2. Callers wanting more page through `listMessages` explicitly.

### 5. `format=metadata` with no `metadataHeaders`

[`resolveUrl`](../../../src/lib/connectors/http-connector.ts#L542-L545) builds
query params with `searchParams.set()`, so a repeated key is impossible and
`metadataHeaders=From&metadataHeaders=Subject` cannot be expressed through
`opts.query`. Requesting `format=metadata` with no `metadataHeaders` returns
*all* headers, which is what we want anyway. No workaround needed.

### 6. `maxResponseBytes: 20 MiB`

Gmail returns attachment bytes base64url-encoded inside a JSON body, inflating
by 4/3. The 8 MiB default would cap attachments at ~6 MB. 20 MiB allows roughly
a 15 MB attachment while keeping a bound on serverless memory; anything larger
raises `payload_too_large`, which is an honest answer. Documented in the method
doc comment.

### 7. `tokenAuth: "post"`

Google documents `client_id` / `client_secret` in the token-endpoint form body.
It accepts HTTP Basic too, but `post` is the documented path and the base
default is `basic`, so it must be declared explicitly.

## Structure

```
connectors/gmail/
  plans/
    20260826_2244-gmail-connector.md   # this file
  connector.json
  index.ts
```

Nothing outside `connectors/gmail/` changes, except the generated
`src/generated/connector-registry.ts`, which is rewritten by the generator and
never by hand.

### `connector.json`

- `name: "gmail"` — matches the folder (invariant 1).
- `credentialFields`: `clientId` (text), `clientSecret` (password). No
  `baseUrl` field — there is no Gmail sandbox to point at, and an editable base
  URL on a credential-bearing connector is an exfiltration lever. The reserved
  `oauth_*` keys are **not** declared (invariant: platform-written).
- `auth`: `oauth2_authorization_code`, `authorizeUrl` carrying
  `access_type=offline&prompt=consent` (decision 1),
  `tokenUrl: https://oauth2.googleapis.com/token`, `tokenAuth: "post"`,
  `credentialKeys: ["clientId", "clientSecret"]`, single scope
  `https://www.googleapis.com/auth/gmail.readonly`.
- `http`: `baseUrl: https://gmail.googleapis.com`, `timeoutMs: 10000`,
  `deadlineMs: 20000`, `maxAttempts: 3`, `maxResponseBytes: 20971520`.
  No `pagination` (decision 3), no `rateLimitOn403` (decision 2).
- `webhook`: **absent.** Gmail push notifications go through Google Cloud
  Pub/Sub with an OIDC JWT, not an HMAC over the raw body, so the platform's
  `hmac-sha256` webhook policy cannot verify them. Out of scope; polling only.
- `telemetry`: the six app-facing methods declared, none with `mutates` — the
  connector is read-only, so every method is legal from an MCP read-only tool.
  `testConnection` is not declared: the Registry calls it directly rather than
  through the `context.connectors.gmail` proxy, so it would never record.
- `lastUpdated`: **not written by hand** — the pre-commit hook stamps it.

### `index.ts`

`export default class GmailConnector extends HttpConnector`, `name = "gmail"`.
Zod schemas on every response an app renders, per the implementation guide.

| Member | Endpoint | Notes |
| --- | --- | --- |
| `testConnection()` | `GET /gmail/v1/users/me/profile` | Cheapest authenticated call; proves client credentials, the grant, and refresh all at once. Returns `Connected to <emailAddress>` — the mailbox identity is exactly what an admin needs to confirm they approved as the right account |
| `listMessages(opts)` | `GET /gmail/v1/users/me/messages` | `q` (Gmail search syntax), `limit`, `pageToken`, `labelIds`, `includeSpamTrash`. Own bounded page loop (decision 3). Returns ids only — `{ messages, nextPageToken, resultSizeEstimate }` — because that is all Gmail returns |
| `searchMessages(opts)` | list + N × `messages.get` | The common case: list and read in one call. Bounded at 25 and sequential (decision 4). Split from `listMessages` rather than a `hydrate` flag, so the return type is not a union and the N+1 cost is visible at the call site |
| `getMessage(id, opts)` | `GET /gmail/v1/users/me/messages/{id}` | `format: "full" \| "metadata" \| "minimal"`. Walks the MIME tree and returns decoded `text` / `html` alongside normalised headers and `attachments[]` metadata |
| `getThread(id, opts)` | `GET /gmail/v1/users/me/threads/{id}` | Same decoding applied to each message in order |
| `listLabels()` | `GET /gmail/v1/users/me/labels` | Resolves label IDs to names. Not paginated by Gmail |
| `getAttachment(messageId, attachmentId)` | `GET /gmail/v1/users/me/messages/{id}/attachments/{aid}` | Returns `{ size, data: Buffer }`, base64url-decoded server-side |

Two private helpers, both pure and stateless:

- `decodeBody(payload)` — recursive walk of Gmail's MIME part tree collecting
  the first `text/plain` and `text/html` parts plus attachment metadata.
  `Buffer.from(data, "base64url")` handles Gmail's URL-safe alphabet directly.
- `headerMap(headers)` — `[{name, value}]` → a lowercased-key record, so
  callers do not re-scan an array for `Subject`.

No module-level state, no caching, no `process.env`, no `fetch` (invariants 11,
18, 3).

## Security notes

- Single scope, read-only: `gmail.readonly`. No `gmail.send`, no
  `gmail.modify`, no `gmail.compose` (invariant 17). Adding one later requires
  its own security note.
- Message content is tenant data. It is returned to app routes, never logged
  and never attached to an error — `request()` deliberately never reads an
  upstream error body, and nothing here catches a `ConnectorError` to add one
  (invariants 16, and the anti-pattern list).
- Every app user reads the same mailbox. Whoever can reach an app that declares
  `gmail` can read that inbox — so the mailbox chosen should be one whose
  contents are appropriate for the whole deployment, and that belongs in the
  admin-facing `description`.
- No `baseUrl` credential, so the connector cannot be re-pointed at an
  attacker-controlled host by anyone with Registry write access.

## Verification

1. `npx tsx scripts/generate-project-registry.ts` — `gmail` appears in the
   regenerated registry; the manifest passes strict schema validation, and the
   generator confirms every `telemetry[].method` exists on the class.
2. `npm run typecheck`.
3. `npm run verify:connectors` — exercises the abstraction (retries,
   `Retry-After`, auth strategies, the failure envelope) against the stub
   upstream.
4. **Google Cloud Console**, in the Workspace org owning the mailbox: enable the
   Gmail API; OAuth consent screen → **Internal**; create a **Web application**
   OAuth client; register the redirect URI shown on the Registry row.
5. Dev server → Administration → Connector Registry: the `gmail` row renders
   with Client ID and Client Secret fields. Save them. Confirm `configured` is
   **false** at this point — the grant does not exist yet, and
   [`configured`](../../../src/lib/connectors/http-connector.ts#L109-L127)
   must say so.
6. Press **Connect**, approve **as the shared mailbox account**. Confirm
   `configured` flips to true.
7. **Prove the refresh token exists** (decision 1 is the risky one). Confirm the
   stored config carries a non-empty `oauth_refresh_token`. Then force the
   refresh path rather than waiting an hour: set `oauth_expires_at` to `0` and
   run Test Connection — it must still succeed, which proves the refresh works
   and not merely that the first access token did.
8. **Test Connection** → `Connected to <the shared mailbox address>`. Check the
   address is the mailbox intended, not the admin's own account.
9. Exercise it for real from a test app API route: `listMessages({ q: "is:unread", limit: 5 })`,
   then `getMessage` on one id and confirm `text`/`html` decode to readable
   content, `listLabels`, `getThread`.
10. **Empty-result regression** (decision 3): call
    `listMessages({ q: "subject:zzzznomatchzzzz" })` and confirm it returns an
    empty array rather than throwing `unexpected_response`.
11. Not claimed done until 5–10 have actually been run against real Gmail.
