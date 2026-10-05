---
title: Security
description: Who can see the files in your Drive, what each key can do, and what we can and cannot reach.
---

# Security

## The short version

Your files live at iDrive e2, in its Paris region (eu-west-3), in a storage
account we hold, and a folder on your machine shows them to you. The
[privacy policy](https://drive-pricing.nishant345.workers.dev/privacy) lists every company that handles your data. Every device and every agent tool gets its own key, and a key can
only do what its kind of key is allowed to do. Keys are yours to revoke.

## What each key can do

{{KEY_TABLE}}

Read and write come from the capability table the server grants
(workers/api/src/keyprovider.js). Delete and reach come from what the storage
provider enforces on the key it mints (workers/api/src/idrive-keys.js), because
a key talks to the storage directly. {{AGENT_DELETE}} {{BRANCH_REACH}}

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
from an authentication app, or a passkey. While it is on, approving a new
device — the "Approve `drive` on this Mac?" page — asks for that code after
the code from the terminal. A code thief who has the terminal output but not
your authentication app approves nothing.

The recovery rule: when you turn the second factor on, the page shows ten
one-time recovery codes once. They are never shown again, so store them
somewhere safe before you close the tab. Each code works once, in place of
the rotating code, and a used code is dead from then on.

If you lose your authentication app, a recovery code approves a device and a
signed-in session can turn the factor off or generate ten new codes. If you
lose both the app and the codes, the sessions already signed in on your
devices are what you have left. We cannot reset a factor for you in version 1:
there is no support path that overrides it, by design — a second factor that
support can switch off is not a second factor.

Passkeys can be registered over the account api; there is no settings page for
them in version 1.

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
  repository or on this site, and the CLI reads them from the environment
  rather than from a file inside the Drive folder.

## Not claimed

We do not claim a compliance certification, an uptime figure or a customer
count. When there is one, it goes on this page with the number and the date.

## Next

- [Agents](/agents) — connecting a tool, and what its key can do.
- [Limits](/limits) — what is not in version 1.
