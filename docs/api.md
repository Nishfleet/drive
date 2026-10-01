# api Worker contract

JSON over HTTPS, served by `workers/api`. Routes are registered in `workers/api/src/routes.js`. Errors are `{"error": "<sentence>"}` with a 4xx or 5xx status. The account gate resolves a CLI's `Authorization: Bearer <device_token>` against the key store, and a browser's sign-in session cookie through the same `signedInAccount` gate the site's account routes use (`src/status.js`, drive#109).

Every route carries an `auth` rule and the account gate is deny by default: only `auth: "public"` answers without a signed-in account, and a route that needs one answers `401` with a `www-authenticate: Bearer` challenge. `test/index.test.js` walks the registry and fails on a route with no rule, so a new route cannot ship open by accident. Request bodies that are not a JSON object are `400`. A path whose `:param` cannot be percent-decoded is `400`; a known path reached with a method it does not serve is `405` with an `allow` header.

Routing is the platform's own `URLPattern`, not a hand-rolled matcher: it is a Workers global, so the api needs no router dependency, and a malformed percent-escape is decoded here where a failure is a `400` rather than an uncaught `URIError`. The `auth` rule is read before the method: a path whose every route needs an account answers `401` without naming which methods it has.

## Routes

The liveness probe is public on purpose: it answers before anyone is signed in, and it reads the clock and nothing else. A route lands here when it lands in `workers/api/src/routes.js`, not before.

| Route | Auth | Purpose |
|---|---|---|
| `GET /v1/health` | public | Liveness. `{ok, time}`. |
| `POST /v1/device/code` | public | Start a device sign-in. Body `{name?}`; answer `{deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval}`. |
| `POST /v1/device/token` | public | The CLI's poll. Body `{device_code}`; `{status: "pending"}` until approved, then `{status: "approved", deviceToken, account}`. The token is returned once. |
| `GET /v1/device/approve` | account | The page the person approves the code on. `?user_code=` prefills the form. |
| `POST /v1/device/approve` | account | Approve a code, as the signed-in person. A form body (`user_code=…`) or `{user_code}`. Anonymous is `401`; past the edge limit is `429`. |
| `GET /v1/keys` | account | The account's keys: `{keys: [{keyId, name, kind, prefix, capabilities, createdAt, lastSeenAt, revokedAt}]}`. No secret is ever listed. |
| `POST /v1/keys` | account | Mint a key. Body `{kind?, name?}` (`device`/`agent`/`s3`/`branch`); answer `{keyId, accessKeyId, secret, prefix, capabilities}`. The secret is in this response and nowhere else. |
| `DELETE /v1/keys/:keyId` | account | Revoke one of the account's own keys. `204`; another account's key is `404`. |
| `GET /v1/storage/list` | public | The stand-in storage API. HTTP Basic with the access key id and secret. `?path=` defaults to the key's prefix. A revoked key is `401`; a path outside the key's own prefix is `403`. The real adapter replaces this behind the same answers (build step 1). |

The account gate resolves `Authorization: Bearer <device token>` through the key store (`workers/api/src/keystore.js`) and, for the approval page, the sign-in session cookie through `src/status.js` `signedInAccount`; a request with neither, or one that does not resolve, is `401` and no handler runs. The device flow is RFC 8628's device authorization grant: the CLI asks for a code, a signed-in person approves it, and the CLI polls until it holds a token. The pending codes and the minted tokens live in D1 (`migrations/drive/0005_device_codes.sql`, `workers/api/src/device-signin.js`), so a code started on one Worker instance is visible on the next; the device code and the token are stored only as SHA-256 digests.

## Key scopes

Storage access goes through the `KeyProvider` interface (`mint(scope)`, `revoke(keyId)`, `swapToReadOnly(keyId)`), see `workers/api/src/keyprovider.js`. `swapToReadOnly` is the one the pricing Worker already calls when the cap takes a key (see `applyCapSwap` in `src/cap.js`); `mint` and `revoke` land with the keys routes.

- device key: list, read, write and delete on `/u/<account>/`
- agent key (and s3 key): the same prefix without delete
- branch key: `/u/<account>/.branches/<name>/` without delete

The kind to capabilities table is `CAPABILITIES_BY_KIND` in `workers/api/src/keyprovider.js`, and it is the only copy: the pricing Worker's cap logic (`src/cap.js`) reads it too, and `test/cap-keyprovider-table.test.mjs` fails if a second copy appears. `scopeFor()` validates the account id and the branch name before they go into a prefix, so a name like `../../x` or `a/b` is refused rather than escaping the account's folder.
