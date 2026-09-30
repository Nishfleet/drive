# api Worker contract

JSON over HTTPS, served by `workers/api`. Routes are registered in `workers/api/src/routes.js`. Errors are `{"error": "<sentence>"}` with a 4xx or 5xx status. Bearer tokens are `Authorization: Bearer <device_token>`.

| Route | Purpose |
|---|---|
| `POST /v1/device/code` | Start device sign-in. Returns `{device_code, user_code, verification_url, interval}` |
| `POST /v1/device/token` `{device_code}` | Poll. Returns `{status: "pending"}` or `{status: "approved", device_token, device_id, storage: {endpoint, bucket, region, access_key_id, secret, prefix}}` |
| `GET /v1/keys` | List the account's keys (never the secrets) |
| `POST /v1/keys` `{kind, name, prefix?}` | Mint a key; `kind` is `agent`, `s3` or `branch`. The secret is returned once |
| `DELETE /v1/keys` `{id}` | Revoke a key |
| `GET /v1/me` | `{account_id, email, state, cap_cents}` |

## Key scopes

Storage access goes through the `KeyProvider` interface (`mint(scope)`, `revoke(keyId)`, `swapToReadOnly(keyId)`), see `workers/api/src/keyprovider.js`.

- device key: list, read, write and delete on `/u/<account>/`
- agent key (and s3 key): the same prefix without delete
- branch key: `/u/<account>/.branches/<name>/` without delete
