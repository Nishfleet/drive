---
title: API reference
description: The HTTP routes behind the drive command, with a copy-paste curl example for each.
---

# API reference

The `drive` command is a thin client for these routes. You can call them
yourself. Every example uses `https://storagebun.com` as the base and keeps a
secret in an environment variable, so nothing sensitive is pasted into a
shell history.

## Authentication

There are three kinds of route.

- **Public.** No credential. They are the first steps of signing in, a health
  check, and the storage routes (those take the key itself, see below).
- **Signed in.** Send the device token you got from the sign-in steps as a
  bearer token: `Authorization: Bearer $DEVICE_TOKEN`. A browser session
  cookie works too.
- **Key.** The storage routes take a storage key with HTTP Basic auth: the
  access key id is the user and the secret is the password.

```shell
export DEVICE_TOKEN=...   # from POST /v1/device/token
export KEY_ID=...         # accessKeyId from POST /v1/keys
export KEY_SECRET=...     # secret from POST /v1/keys
```

## Errors

An error is a JSON object with one field, `error`, in plain words you can show
a person.

```json
{ "error": "This key was revoked or is not valid." }
```

| Status | Meaning |
| --- | --- |
| 400 | The request is not in the shape the route wants. |
| 401 | No credential, or the credential is revoked or expired. |
| 402 | The balance is empty, so a write is refused. |
| 403 | The credential is fine, but the path is outside its folder. |
| 404 | No such thing on this account. |
| 405 | The route does not take that method. |
| 409 | The request clashes with the state of the account (for example the live-key cap). |
| 429 | Too many requests. Wait for the time in the answer. |

## Health

### `GET /v1/health`

Public. Answers when the API is up.

```shell
curl https://storagebun.com/v1/health
```

```json
{ "ok": true, "time": "2026-10-12T10:00:00.000Z" }
```

## Sign in a device

A device signs in with a short code that a person approves in a browser. Nothing
secret goes through the address bar.

### `POST /v1/device/code`

Public. Starts a sign-in. The optional `name` is shown on the approval page and
in the device list, so two laptops can be told apart.

```shell
curl -X POST https://storagebun.com/v1/device/code \
  -H 'content-type: application/json' \
  -d '{"name":"work-laptop"}'
```

Answers `deviceCode`, `userCode`, `verificationUri`, `verificationUriComplete`,
`expiresIn` and `interval` (seconds between polls). Open
`verificationUriComplete` in a browser, sign in, and approve.

### `POST /v1/device/token`

Public. Poll this every `interval` seconds with the `deviceCode`.

```shell
curl -X POST https://storagebun.com/v1/device/token \
  -H 'content-type: application/json' \
  -d '{"device_code":"..."}'
```

While the person has not approved: `{ "status": "pending" }`. After approval:
`status`, `deviceToken`, `expiresAt` (epoch seconds) and the `account`
(`id`, `name`, `email`). If the code has expired the answer is a 400 that says
so; ask for a new code.

### `DELETE /v1/device/token`

Signed in. Revokes the token that made the request, which signs this device out.

```shell
curl -X DELETE https://storagebun.com/v1/device/token \
  -H "authorization: Bearer $DEVICE_TOKEN"
```

## Keys

A key lets one tool read and write one folder. The secret is shown once, when
the key is made, and is never stored.

### `GET /v1/keys`

Signed in. Lists the account's keys, without secrets.

```shell
curl https://storagebun.com/v1/keys -H "authorization: Bearer $DEVICE_TOKEN"
```

### `POST /v1/keys`

Signed in. Makes a key. `kind` is one of `device`, `agent`, `s3` or `branch`
(default `agent`). `name` is optional. Answers `201` with `keyId`,
`accessKeyId`, `secret`, and, when the key expires, `expiresAt`. An account has
a cap on live keys; past it the answer is a 409.

```shell
curl -X POST https://storagebun.com/v1/keys \
  -H "authorization: Bearer $DEVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kind":"agent","name":"build-bot"}'
```

### `POST /v1/keys/:keyId/renew`

Signed in. Restarts the hour of a key that expires. A revoked key cannot be
renewed (409).

```shell
curl -X POST https://storagebun.com/v1/keys/KEY_ID/renew \
  -H "authorization: Bearer $DEVICE_TOKEN"
```

### `DELETE /v1/keys/:keyId`

Signed in. Revokes one key. It stops working from the next request. Answers 204.

```shell
curl -X DELETE https://storagebun.com/v1/keys/KEY_ID \
  -H "authorization: Bearer $DEVICE_TOKEN"
```

### `DELETE /v1/keys`

Signed in. Revokes every key and every device token on the account, including the
one that asked. Answers 204.

```shell
curl -X DELETE https://storagebun.com/v1/keys -H "authorization: Bearer $DEVICE_TOKEN"
```

### `POST /api/keys/revoke`

Public. A key revokes itself: send the key's own id and secret as Basic auth.
This is what `drive logout` does. Answers 204.

```shell
curl -X POST https://storagebun.com/api/keys/revoke -u "$KEY_ID:$KEY_SECRET"
```

## Storage

These two routes take the key as Basic auth and only reach the key's own
folder. A path outside it is a 403.

### `GET /v1/storage/list`

Lists what is under `path` (the key's folder when you leave it out).

```shell
curl -u "$KEY_ID:$KEY_SECRET" 'https://storagebun.com/v1/storage/list?path=/docs'
```

Answers `prefix`, `path` and `objects`.

### `PUT /v1/storage/object`

Writes the request body to `path`. A write is refused with a 402 when the
balance is empty, in the words the web app uses.

```shell
curl -X PUT -u "$KEY_ID:$KEY_SECRET" \
  --data-binary @report.pdf \
  'https://storagebun.com/v1/storage/object?path=/docs/report.pdf'
```

Answers `prefix`, `path` and `sizeBytes`.

## Teams

A team has its own folder. Every route checks that you belong to the team, so a
team you are not in is a 404.

### `POST /v1/teams`

Signed in. Body `{ "name": "..." }`. Answers `201` with `team`.

```shell
curl -X POST https://storagebun.com/v1/teams \
  -H "authorization: Bearer $DEVICE_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Design"}'
```

### `GET /v1/teams`

Signed in. Answers `teams`, the ones you belong to.

```shell
curl https://storagebun.com/v1/teams -H "authorization: Bearer $DEVICE_TOKEN"
```

### `POST /v1/teams/:teamId/members`

Signed in. Invites a member by email. Body `{ "email": "...", "role": "..." }`
(`role` is optional). Answers `201` with `member`.

```shell
curl -X POST https://storagebun.com/v1/teams/TEAM_ID/members \
  -H "authorization: Bearer $DEVICE_TOKEN" \
  -H 'content-type: application/json' -d '{"email":"sam@example.com"}'
```

### `GET /v1/teams/:teamId/members`

Signed in. Lists the team's members.

```shell
curl https://storagebun.com/v1/teams/TEAM_ID/members \
  -H "authorization: Bearer $DEVICE_TOKEN"
```

### `DELETE /v1/teams/:teamId/members/:memberId`

Signed in. Removes a member and revokes their keys, which stop on the next
request.

```shell
curl -X DELETE https://storagebun.com/v1/teams/TEAM_ID/members/MEMBER_ID \
  -H "authorization: Bearer $DEVICE_TOKEN"
```

### `POST /v1/teams/:teamId/key`

Signed in. Makes a key for the team folder. Body `{ "name": "..." }` is
optional. Answers `201` like `POST /v1/keys`.

```shell
curl -X POST https://storagebun.com/v1/teams/TEAM_ID/key \
  -H "authorization: Bearer $DEVICE_TOKEN"
```

## Upload queue

The mount reports how much is waiting to upload so `drive status` can say so.

### `POST /v1/queue`

Signed in. Body: `files`, `uploadedBytes`, `totalBytes` (whole numbers) and
`paused` (true or false). `uploadedBytes` cannot be more than `totalBytes`.
Answers `reported` and `reportedAt`. Reports faster than the allowed interval
get a 429 with a retry-after.

```shell
curl -X POST https://storagebun.com/v1/queue \
  -H "authorization: Bearer $DEVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"files":3,"uploadedBytes":1024,"totalBytes":4096,"paused":false}'
```

### `DELETE /v1/queue`

Signed in. Clears the report. Answers `{ "cleared": true }`.

```shell
curl -X DELETE https://storagebun.com/v1/queue -H "authorization: Bearer $DEVICE_TOKEN"
```

## Export

### `GET /v1/export`

Signed in. Your own data: the account, its keys, the file-name index and the
version history. Nothing of anyone else's.

```shell
curl https://storagebun.com/v1/export -H "authorization: Bearer $DEVICE_TOKEN" -o drive-export.json
```

## Not documented yet

These are real, but this page does not describe them yet, because the exact
wire shapes are still being settled.

- The fields inside `team`, `member`, `keys[]`, `objects[]` and the export.
- `GET` and `POST /v1/device/approve`, the browser page where a person approves a code.
- `POST /v1/events`, which only the storage server calls.
