---
title: Security
description: Who can see the files in your Drive, what each key can do, and what we can and cannot reach.
---

# Security

## The short version

Your files live at iDrive e2, in its Paris region (eu-west-3), in a storage
account we hold, and a folder on your machine shows them to you. The
[privacy policy](https://storagebun.com/privacy) lists every company that handles your data. Every device and every agent tool gets its own key, and a key can
only do what its kind of key is allowed to do. Keys are yours to revoke.

## Sub-processors

The
[privacy policy](https://storagebun.com/privacy) is the
full record, with what each one stores and where. The page below is the
same list; it is read from the privacy page so the count can never
silently disagree with it.

- **Cloudflare** — the site, the API, downloads, the account database and email.
  Cloudflare's global network.
- **iDrive e2** — the object storage that holds your files and their old
  versions. Paris, France (region eu-west-3).
- **Dodo Payments** — card payments, refunds, and the card itself. We never hold
  a card number.

## What each key can do

{{KEY_TABLE}}

Read and write come from the capability table the server grants. Delete and
reach come from what the storage provider enforces on the key it mints, because
a key talks to the storage directly. {{AGENT_DELETE}} {{BRANCH_REACH}}

On Linux and macOS, `drive init` mounts `~/Drive-agents/<tool>` for each tool
on that tool's own key. The MCP server and the tool's allowed folders point at
that folder, not at the folder you use. Windows is not in version 1, and the tool there still works inside
your Drive, because the agent mount is not proven there.

## The spending cap

Set a cap and the drive goes read-only at it: nothing is deleted and the bill
stops there. The default cap is {{DEFAULT_CAP}}. It protects your bill rather
than your files.

Raise the cap and the drive starts writing again: the write key comes back, the
mount picks it up at its next start (`drive cap` restarts it for you), and the
uploads that waited in the cache go up.

## Revoking

`drive logout` stops the mount and removes this machine's key and config. A key
that no longer exists cannot be used, and the next mount asks for a new one.
Each agent tool is revoked on its own with `drive agents revoke <tool>`.

## The second factor

You can turn on a second factor for your account: a rotating six-digit code
from an authentication app. While it is on, approving a new
device — the "Approve `drive` on this Mac?" page — asks for that code after
the code from the terminal. A code thief who has the terminal output but not
your authentication app approves nothing.

The recovery rule: when you turn the second factor on, the setup hands you
ten one-time recovery codes once. They are never shown again, so store them
somewhere safe right away. Each code works once, in place of the rotating
code, and a used code is dead from then on.

If you lose your authentication app, a recovery code approves a device and a
signed-in session can turn the factor off or generate ten new codes. If you
lose both the app and the codes, the sessions already signed in on your
devices are what you have left. We cannot reset a factor for you in version 1:
there is no support path that overrides it, by design — a second factor that
support can switch off is not a second factor.

A passkey is a way to sign in. It is not the second factor, and approving a
new device does not accept it in place of the authentication-app code or a
recovery code. An account that has a passkey and no authentication app is
asked for no second factor when it approves a device.

Approving a device with a device token alone, with no browser session, is
refused for an account that has the second factor on, because only a browser
session can present the code.

Passkeys and the second factor are set up over the account api; there is no
settings page for either in version 1.

## What we can and cannot reach

Stated plainly, because a security page that lists only the good news is not
useful:

- **We cannot claim we cannot reach your files.** We hold the storage account
  they sit in, so an operator with production access to that account can reach the
  bytes, and there is no end-to-end encryption in version 1.
- **We cannot read a file through your key.** A key can only do what its kind of
  key is allowed to do, and a key that has been revoked is dead from then on.
- **A key, and a session running as you, can read your files.** That is the
  product: the point is that your agents can read them.
- **We cannot keep your secrets for you.** They do not live in the Drive
  repository or on this site. The CLI keeps them on this machine as files
  only your user can read, never inside the Drive folder.

## Not claimed

We do not claim a compliance certification, an uptime figure or a customer
count. When there is one, it goes on this page with the number and the date.

## Next

- [Agents](/agents) — connecting a tool, and what its key can do.
- [Limits](/limits) — what is not in version 1.
