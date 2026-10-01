# api Worker contract

JSON over HTTPS, served by `workers/api`. Routes are registered in `workers/api/src/routes.js`. Errors are `{"error": "<sentence>"}` with a 4xx or 5xx status. Bearer tokens are `Authorization: Bearer <device_token>`.

Every route carries an `auth` rule and the account gate is deny by default: only `auth: "public"` answers without a signed-in account, and a route that needs one answers `401` with a `www-authenticate: Bearer` challenge. `test/index.test.js` walks the registry and fails on a route with no rule, so a new route cannot ship open by accident. Request bodies that are not a JSON object are `400`. A path whose `:param` cannot be percent-decoded is `400`; a known path reached with a method it does not serve is `405` with an `allow` header.

Routing is [Hono](https://hono.dev), the standard router for Cloudflare Workers (`workers/api/src/index.js`, `createApp`). Path matching, `:params`, trailing slashes, `404` and `405` are the library's, not a hand-written matcher: the registry in `workers/api/src/routes.js` is registered onto the app, and `workers/api/test/index.test.js` walks Hono's own route table (`app.routes`, minus the router's internal `ALL` middleware entries) so a route the app registers and the registry does not, or the reverse, fails the walk, and dispatches real anonymous requests at every account route so a route registered without its gate fails too. A trailing slash is served, never redirected. A malformed percent-escape is a `400` rather than an uncaught `URIError`. The account gate is Hono middleware, deny by default: the `auth` rule decides a path before the method does, so a path whose every route needs an account answers `401` without naming which methods it has. A path that also carries a public route (device sign-in's `POST /v1/device/token` is the one) gates only its account routes: the public half keeps answering, the gated half is the gate's own `401`, and the path's `405` `allow` names only the methods an anonymous caller may reach — all of them once signed in.

## Routes

The liveness probe is public on purpose: it answers before anyone is signed in, and it reads the clock and nothing else. A route lands here when it lands in `workers/api/src/routes.js`, not before.

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/health` | public | Liveness. `{ok, time}`. |
| `POST /v1/device/code` | public | Start a device sign-in. Body `{name?}`; answer `{deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval}`. |
| `POST /v1/device/token` | public | The CLI's poll. Body `{device_code}`; `{status: "pending"}` until approved, then `{status: "approved", deviceToken, account}`. The token is returned once. |
| `GET /v1/device/approve` | public | The page the person approves the code on. `?user_code=` prefills the form. |
| `POST /v1/device/approve` | public | Approve a code. A form body (`user_code=…`) or `{user_code}`. Until the account sign-in flow lands, approving makes the account. |
| `GET /v1/keys` | account | The account's keys: `{keys: [{keyId, name, kind, prefix, capabilities, createdAt, lastSeenAt, revokedAt}]}`. No secret is ever listed. |
| `POST /v1/keys` | account | Mint a key. Body `{kind?, name?}` (`device`/`agent`/`s3`/`branch`); answer `{keyId, accessKeyId, secret, prefix, capabilities}`. The secret is in this response and nowhere else. |
| `DELETE /v1/keys/:keyId` | account | Revoke one of the account's own keys. `204`; another account's key is `404`. |
| `DELETE /v1/device/token` | account | Revoke the caller's own device token. The token is the one in the `Authorization: Bearer` header. `204`; subsequent requests with that token are `401`. |
| `GET /v1/storage/list` | public | The stand-in storage API. HTTP Basic with the access key id and secret. `?path=` defaults to the key's prefix. A revoked key is `401`; a path outside the key's own prefix is `403`. The real adapter replaces this behind the same answers (build step 1). |

The account gate resolves `Authorization: Bearer <device token>` through the key store (`workers/api/src/keystore.js`); a request with no token, or a token that does not resolve (unknown, expired, or revoked), is `401` and no handler runs. The device flow is RFC 8628's device authorization grant.

## Key scopes

Storage access goes through the `KeyProvider` interface (`mint(scope)`, `revoke(keyId)`, `swapToReadOnly(keyId)`), see `workers/api/src/keyprovider.js`. `swapToReadOnly` is the one the pricing Worker already calls when the cap takes a key (see `applyCapSwap` in `src/cap.js`); `mint` and `revoke` land with the keys routes.

- device key: list, read, write and delete on `/u/<account>/`
- agent key (and s3 key): the same prefix without delete
- branch key: `/u/<account>/.branches/<name>/` without delete

The kind to capabilities table is `CAPABILITIES_BY_KIND` in `workers/api/src/keyprovider.js`, and it is the only copy: the pricing Worker's cap logic (`src/cap.js`) reads it too, and `test/cap-keyprovider-table.test.mjs` fails if a second copy appears. `scopeFor()` validates the account id and the branch name before they go into a prefix, so a name like `../../x` or `a/b` is refused rather than escaping the account's folder.
