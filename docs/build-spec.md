# Competing drive: build spec

> **Status note (2026-10-02):** this is the historical build plan. The code and the open issues are the source of truth, and where they differ the code wins. Shipped work is listed in `docs-site/changelog.md`.

Written 2026-09-29, on Nish's ask ("lets get to speccing?"). This turns the build plan in `spec.md` into what each part does, the commands and screens, the data model, and the steps in detail. `spec.md` still holds the why: prices, rivals and the pressure test.

**Status: building since 2026-09-29** (Nish: "lets go then"). Issues #2 to #15 in this repo; spending money (storage accounts, Storage Box) still needs Nish.

## Decisions this spec uses

| Decision | Value | State |
|---|---|---|
| Primary storage | **iDrive e2** at $5/TB-month (reseller plan), one bucket per customer, each key limited to that one bucket (drive#371). Backblaze B2 is the standby if iDrive's reseller API stops answering. The spec says B2 further down; those lines are updated with this row | Nish, 2026-09-29; iDrive stays primary 2026-10-04 (drive#371) |
| Price | **drive#642 (current, replaces #463):** 2¢ per GB-month on the biggest size in the last 30 days, never more than $15 per TB. Historical #463: 2¢ per GB-month, billed by the minute; the monthly bill never passes max($12, $8 × peak TB), TB measured to the GB. B2 fallback: $10/TB | Nish, 2026-10-05 (#642); 2026-09-30 (#463, replaced) |
| Billing unit | **drive#642:** trailing 30-day peak (size30), drawn once a day. Historical: **Per minute** (not per second). Never advertise a per-minute price. | Nish, 2026-10-05 (#642); 2026-09-29 (#463, replaced) |
| Minimum per file | 1 hour | Asked 2026-09-29; default **yes** until Nish answers |
| Prepaid | Add $10 or more. No plans. Your balance never expires. A card is needed at sign-up because there is no free tier. | drive#586; retired the $10 membership |
| Old versions | **Free to the user.** Kept 1 day in B2, then 30 days on the Hetzner Storage Box (about $2.3/TB against B2's $6.95) | Nish, 2026-09-29 ("move it to hetzner for 30 days"). Catch: if a file is saved several times in one day, only that day's last version reaches Hetzner |
| Downloads | Free up to 3x average stored data each month, then 1¢/GB | spec.md |
| Spending cap | Required at sign-up (default $20, user-adjustable; Nish via #464, decided 2026-10-04). Email at 80%. At the cap the drive goes read-only for uploads; downloads keep working; nothing is deleted. The cap counts min(metered so far, ceiling), not the raw meter | #464 decision 2026-10-04, changelog 2026-10-05 |
| Platforms | macOS and Linux. No Windows in v1 | spec.md |
| Headline price | "Add $10 or more. Pay 2 cents per GB from your balance. Never more than $15 per TB." from `core/pricing.js` (PRICE.headline) | drive#463, drive#586, drive#642 |
| Bill ceiling | Never more than $15 per TB, counted to the GB, on size30 (`PRICE.maxUsdPerTb`, `monthBillCents` in `core/billing.js`). The older max($12, $8 × peak TB) and $10 per TB rows are retired. | Nish, 2026-10-05 (drive#642) |
| Company tier | "Business": same storage price, plus single sign-on, SOC 2 report, one company bill split by team, and priority support. On the pricing page from day one as "Talk to us"; built after v1. The company UI is later, so the teams API is the only v1 path to a company drive: `docs/api.md` documents `POST /v1/teams`, the invite that names an email and a role (`read_only` / `read_write`), and the removal that revokes the member's key (drive#20, drive#518) | Nish, 2026-09-29 |
| Never do | Confusing credit units, balances that expire, "unlimited" plans | Nish, 2026-09-29 (Higgsfield research). Any prepaid top-up never expires |
| Encryption | B2 server-side encryption (SSE-B2) on. Not end-to-end in v1 | My default |

## The pieces

```
 Mac / Linux                          Cloudflare                         Backblaze B2
 ┌────────────────────┐   sign-in   ┌──────────────────────┐   mint keys  ┌──────────────┐
 │ drive CLI          │────────────▶│ api Worker + D1      │─────────────▶│ bucket       │
 │  └ rclone nfsmount │             │  accounts, keys,     │◀─ events ────│  /u/<id>/... │
 │     (or rclone     │── uploads ──┼──────────────────────┼─────────────▶│  versioning  │
 │      mount)        │             │ dl Worker            │◀── reads ────│  1-day rule  │
 │ agent tools (MCP)  │── reads ───▶│  counts bytes        │              └──────┬───────┘
 └────────────────────┘             │ Cron: meter + Dodo   │──▶ Dodo billing     │ nightly rclone sync
                                    └──────────────────────┘                     ▼
                                                                         Hetzner Storage Box
```

1. **drive CLI** (on the user's machine). One binary. Signs in, writes the rclone config, starts the mount as a login item, registers agent tools, runs branch commands. Language: Go, because rclone is Go and the CLI ships as one file; it calls the installed `rclone` binary rather than embedding it.
2. **The mount.** Stock rclone. Mac: `rclone nfsmount` (uses macOS's built-in NFS, so no macFUSE). Linux: `rclone mount`. Both with `--vfs-cache-mode full --vfs-write-back 5s --vfs-cache-max-size 20G --vfs-read-ahead 128k --b2-download-url https://dl.<domain>`, and both with `--dir-cache-time 24h`: S3 sends no change notifications, so listings stay fresh through `vfs/refresh` from the fill loop while storage answers (issue #541). A 5s directory cache made the other machine see a save in about 5 s (measured 2026-09-30 against a local S3 stand-in with two mounts) but turned a kept-offline folder into "Input/output error" five seconds after the network dropped, because rclone re-lists when the cache is older than this and has no stale-on-error (rclone#1963). `--vfs-read-ahead 128k` is the stock extra disk read-ahead with cache-mode full (issue #227). `--vfs-refresh` is not passed at mount start: rclone would walk the whole tree then, which is the wrong trigger for "prefetch the next folder" and delays mount-ready. Child listings after a folder is listed have no rclone flag, so `drive prefetch` (a second login item, Nice 19) does only that leftover work. Kept running by launchd (Mac) or a systemd user unit (Linux), both written by the CLI.
3. **api Worker** (Cloudflare Workers + D1). Accounts, device sign-in, key minting, spending cap, branch bookkeeping, the web pages. Holds the B2 master key as a Worker secret; nothing else does.
4. **dl Worker** (Cloudflare Workers). Sits on the download hostname. Streams B2 reads through Cloudflare (B2 to Cloudflare egress is free) and adds the bytes to the user's download counter, found from the `/u/<id>/` path.
5. **Meter** (Worker Cron Trigger, hourly). Turns file events into GB-minutes per user, pushes usage to Dodo, and flips accounts to read-only at their cap. The schedule's reason: Dodo needs periodic usage reports.
6. **Reconciler** (Worker Cron Trigger, nightly). Lists each user's file versions in B2 and fixes any event the meter missed. The schedule's reason: B2 event delivery can drop or repeat events.
7. **Backup and old versions.** Nightly `rclone sync b2:bucket box:current --backup-dir box:old/<today>` from B2 to a Hetzner Storage Box, run as a systemd timer on the netcup VPS (default runner; change at go time if the VPS is a bad fit). rclone's `--backup-dir` moves any file that changed or was deleted into that day's folder instead of throwing it away, so `box:old/` holds 30 days of old versions. The same timer runs `rclone purge box:old/<31 days ago>` to drop the oldest day. Restores from Hetzner are copied back into B2 by the same runner.
8. **Billing.** Dodo usage meters, hosted checkout and customer portal. We store no card data.

## Commands (v1)

| Command | What it does |
|---|---|
| `drive login` | Open the browser to the device-approve page, poll the token, mint this machine's key, and write the storage settings. After this, `drive init` and `drive mount` need no pasted keys. |
| `drive init` | Sign in (opens the browser for a device code), make the drive folder (`~/Drive`), start the mount, find installed agent tools and connect each one. Safe to run again. |
| `drive status` | Mounted or not, files waiting to upload and why, this month's cost so far, cap |
| `drive usage` | Stored GB now, GB-months so far, downloads used out of the free 3x, cost so far |
| `drive cap <dollars>` | Change the spending cap |
| `drive history <file>` | List saved versions: today's from B2, older ones (one per day, up to 30 days) from Hetzner |
| `drive restore <file> [--version <id>]` | Bring back a version or an agent-deleted file. Today's versions come back at once; older ones are copied back from Hetzner within a few minutes |
| `drive agents` | List connected agent tools and their keys |
| `drive agents connect <tool>` / `revoke <tool>` | Connect one tool, or cut its key off |
| `drive branch <folder> [--name <n>]` | Instant copy of a folder for an agent to work in, with its own key limited to that copy |
| `drive branches` | List branches, with how many files changed |
| `drive diff <branch>` | Files added, changed or removed against the original |
| `drive approve <branch>` | Copy the branch's changes back. Stops and lists files if the original changed since branching |
| `drive discard <branch>` | Delete the branch (kept in old versions for 30 days, then gone) |
| `drive unmount` / `drive mount` | Stop or start the drive |
| `drive logout` | Unmount, revoke this device's key on the server (the api Worker's `/api/keys/revoke`, key in HTTP Basic auth), then delete the key and local config. A revoke that fails still deletes the local copy and exits non-zero: "signed out here; the key is still live". |
| `drive export [flags]` | Write this account's data to a file (or stdout) |
| `drive import <remote>` | Copy files from an rclone remote the user already made with `rclone config` (Dropbox and Google Drive backends included) into the mounted drive folder, using rclone's own `copy`. No OAuth app of ours; we hold no third-party credentials. The drive must be mounted. |
| `drive uninstall` | Stop the mount and remove the login item that starts it at the next login. The files in the drive folder, the key and the config are kept — `drive logout` is the command that revokes the key and deletes the config. |

## Screens (v1)

Web pages are served by the api Worker. There is no Mac app in v1; Finder is the app.

| Screen | What's on it |
|---|---|
| Sign in | Email one-time link only. The page hides the Google and GitHub offers on purpose (issue #180): they are a closed door, not a 202 for a redirect to nowhere. A card is needed at sign-up |
| Device approval | "Approve `drive` on Nish's MacBook?" with the code from the terminal, and for an account with a second factor turned on (drive#524), that factor as well: the rotating code or a recovery code |
| Usage | One "you saved" line, whose copy varies by month type (decided #39, 2026-09-30): a capped month (metered > ceiling) shows "Our price cap saved you $X" with X = metered − bill; an uncapped month shows "You paid $X less than a flat plan" with X = ceiling − bill. Hidden when the figure is ≤ 0, and on a month with no bill at all (an empty drive is not a saving against anything). Then stored GB (line chart, last 30 days), this month's cost, downloads out of the free 3x, cap slider |
| Devices and agents | Every key: device or agent tool, last used, revoke button (`/devices`, drive#525) |
| Billing | Dodo's hosted portal: card, invoices, the prepaid balance |
| Branches | CLI only in v1 (`drive branch`, `drive branches`, `drive approve`, `drive discard`). No web branch or rewind screen. |

Pricing page (drive#642, replaces #463's per-minute average): the pitch is "Pay only for what you use." The rule is you pay for the biggest size your drive reached in the last 30 days, 2¢ per GB a month, never more than $15 per TB. The home page leads with that, not "cheaper than a plan", because at 1 TB we cost the same $15 as a usual plan and above 1 TB we cost more. A public savings calculator (issue #14) takes a size and shows this month's bill (`monthBillCents`) beside our maximum and a usual 1 TB plan, with no rival names or rival prices; worked examples from the same function; a Business column with "Talk to us". We need a card at sign-up because there is no free tier. No per-minute price, no credit units, no "unlimited". The numbers and the canonical sentences live in `core/pricing.js` (PRICE), the single price module `core/seo.js` reads: the page copy, the meta tags and llms.txt are all gated against that config, `core/billing.js`'s `monthBillCents()` is the one function that turns those numbers into dollars, and `test/pricing-copy.test.mjs` builds its expectations from that config and that function, so copy that drifts from the numbers fails CI.

## Agent tools

`drive init` checks which tools are installed and connects each one. Each gets its own key: read and write, limited to the user's own bucket (drive#371), with **no `deleteFiles`**. An agent's delete therefore only hides a file, and `drive restore` brings it back.

| Tool | How it's connected |
|---|---|
| Claude Code | `claude mcp add drive -- npx -y @modelcontextprotocol/server-filesystem ~/Drive` |
| Codex | `codex mcp add drive -- npx -y @modelcontextprotocol/server-filesystem ~/Drive` |
| Cursor | Entry in `~/.cursor/mcp.json` |
| Gemini CLI | `gemini mcp add drive npx -y @modelcontextprotocol/server-filesystem ~/Drive` |
| Kiro | Entry in `~/.kiro/settings/mcp.json` |

Agents that run on a server rather than the laptop get an S3 key instead (`drive agents connect s3`): an endpoint, key id and secret, limited in the same way.

The storage secret is never read from a command line, where it would sit in the shell history and in `ps` for every user on the machine. `drive mount` reads it from the drive config file (`~/.config/drive/rclone.conf`, mode 0600), from `DRIVE_S3_SECRET_ACCESS_KEY`, or from stdin with `--secret-key-stdin`. The `--secret-key` flag is refused with an error naming these three ways.

When a revoke fails, `drive logout` records the access key id of the key it could not turn off (never the secret) and every later `logout` keeps reporting that a key is live until that exact key is revoked. So signing in again with a new key, then logging out and revoking the new key, still reports the older key — the exit code is non-zero while any recorded key is still live, never a clean sign-out.

Each tool also gets a short skill note: where the drive is, that deletes can be undone, and to use `drive branch` before large edits. Exact command syntax is checked against each tool's current docs in build step 4.

## Sandbox platforms (build step 11)

Two connectors, so the drive works inside a sandbox. The first fits a platform that allows FUSE; the second needs nothing of the platform but HTTP, so it is the one that works everywhere.

| Connector | How | Use when |
|---|---|---|
| Mount | `drive init --token <sandbox token>` runs headless: it exchanges the token for a scoped agent key (no `deleteFiles`), writes the rclone config and mounts with `rclone mount` | The sandbox allows FUSE |
| Hosted MCP | The api Worker's remote MCP over HTTP lists, reads and writes the drive with no mount; a write is guarded by `If-Match` against the ETag the agent read | The sandbox does not allow FUSE, or the agent has no shell |

Each platform, what its docs allow, and the free tier the connector has to fit. Read 2026-09-30; a page that does not state FUSE is called that here, not assumed. Listing and publishing is preview-then-autonomous and waits for the connector code and a preview (`brand`), so this table records the surface and what to publish, not a live listing.

| Platform | FUSE | Surface to publish on (free) | Free tier, with the page's own words |
|---|---|---|---|
| Vercel Sandbox | Yes. The overview lists "System-privileged processes: Run workloads that need system-level privileges, such as container runtimes like Docker, VPN clients, and FUSE filesystem drivers", and its **Mount remote storage** page mounts "an external object store such as Amazon S3 ... with a FUSE driver" | Vercel Templates and the Marketplace/Integrations docs; the Sandbox "Mount remote storage" page is the integration doc to match | Hobby: "Sandbox is free for Hobby users within the usage quotas" — 5 active-CPU hours/month, 420 GB-hours memory, 5,000 creations, 45-minute max session, 10 concurrent sandboxes (`/docs/vercel-sandbox/pricing`) |
| Daytona | Yes. Its **Mount External Storage** doc opens "External storage is mounted using FUSE", with a section per provider (Amazon S3 via `mount-s3`, Cloudflare R2, Tigris, Supabase, GCS, Azure Blob, Box) and two shapes: a pre-built snapshot, or runtime install | A Daytona **Snapshot** built with `mount-s3` (plus the drive rclone config) is the reusable artifact; the docs also list Volumes and "Mount External Storage" | "$200 in free compute included", "Sign up for a free trial - no credit card required" (daytona.io/pricing) |
| boat.dev | Not stated in the pages read (Quickstart, Pricing & Limits, Environments, Setup & Scripts, Snapshots & Copies, Integrations & adapters) | The **Integrations & adapters** docs section (it already holds Eve and Harbor adapter pages — a drive adapter page goes here) and the SDKs page; **Setup & Scripts** is where a one-line install belongs | "Trial: 25 free hours, 2 sandboxes at once, small and default only, until your first payment" (docs.boat.dev/pricing); a plan includes a free 7-day trial |
| E2B | Not stated in the pages read (E2B docs, Sandbox Templates). Its template build environment is "a full sandbox environment, so you can do anything during the build that you can do inside a running sandbox, including running Docker containers" — the FUSE question is settled by a real sandbox test, not a doc | An E2B **Template** (its docs support "one template per customer, per project, or per agent run"); the Templates docs are the integration doc | Hobby: "$100 of usage in credits", "No credit card required", sessions up to 1 hour, 20 concurrent sandboxes, 10 GiB storage free (e2b.dev/pricing) |
| InstaCloud (instacloud.com, "Agent-Native Cloud", InsForge) | Not stated in the page read | It already has a **Templates** section and an **Agent Directory**, and its one-line connect is `npx -y insta@latest setup agent` — the drive goes in the Agent Directory and ships as a template | "Deploying For Free" / "Start Building Today" (instacloud.com); its pricing page needs a read before a listing since the tier text is thin |

Read the FUSE cell for boat.dev, E2B and InstaCloud in the first real sandbox on each; until then the hosted MCP connector is the one that needs no FUSE.

## Data model (D1)

| Table | Columns | Notes |
|---|---|---|
| `accounts` | id, email, created_at, dodo_customer_id, card_added_at, cap_cents, state (`active` / `read_only` / `closed`) | `read_only` once the cap is hit |
| `devices` | id, account_id, name, kind (`device` / `agent` / `s3` / `branch`), b2_key_id, capabilities, prefix, created_at, last_seen_at, revoked_at | The B2 secret is shown once to the device, never stored |
| `file_versions` | account_id, b2_file_id, path, size_bytes, created_at, hidden_at, deleted_at | One row per B2 version; the meter's source of truth |
| `usage_minutes` | account_id, hour, gb_minutes_live, download_bytes | Rolled up hourly |
| `billing_pushes` | account_id, hour, dodo_event_id, amount_units, pushed_at | Stops double-charging if a push retries |
| `branches` | id, account_id, name, source_prefix, branch_prefix, created_at, snapshot (JSON path to size and modified time), state (`open` / `approved` / `discarded`) | The snapshot finds clashes at approve time |
| `teams` | id, owner_account_id, name, created_at | One shared drive; its prefix is `t/<id>/` (issue #20) |
| `team_members` | id, team_id, account_id, email, role (`read_only` / `read_write`), state (`invited` / `active` / `removed`), invited_at, joined_at, revoked_at | `account_id` is empty until an email invite binds to a signed-in account; a removed row is kept, not deleted |
| `events_seen` | b2_event_id, received_at | Drops duplicate B2 events |

## How the money is worked out

- Each file version is billed from `created_at` until `hidden_at` (when it's replaced or deleted). Old versions are free to the user: B2 keeps them 1 day and Hetzner keeps them 30, and we absorb that cost.
- GB-minutes = size in GB × whole minutes stored, with at least 60 minutes per version (the 1-hour minimum). One exception (drive #104): a version that stopped at the instant a same-size version took its place does not book a second minimum. A folder move is a copy then a delete, so the retired version's bytes never left the drive and the successor bills them from that instant. The minimum is booked once per holding, by the version that ends it.
- Monthly cost = total GB-minutes ÷ the minutes in that UTC calendar month (40,320 to 44,640) × 2¢, so 1 TB held all month was $20.00 at the bare rate (replaced by drive#642: the bill reads size30 and never passes $15 per TB).
- Downloads: bytes counted by the dl Worker. Anything above 3x the average stored GB that month is billed at 1¢/GB.
- The membership is $10 a month, and storage use counts toward it. Go past $10 and you pay by the minute for the rest. A card is needed at sign-up because there is no free tier.
- The monthly invoice and usage page show one "you saved" line, with the baseline chosen by month type (decided #39, 2026-09-30; Nish can overrule). Capped month (metered > ceiling): saved = metered − bill, copy "Our price cap saved you $X". Uncapped month: saved = ceiling − bill, copy "You paid $X less than a flat plan". Hidden when the figure is 0 or less, and on a month with no bill (an empty drive costs $0 on every plan, so there is nothing to have saved). The bill itself is min(metered, ceiling); the ceiling is applied at invoice time, so Dodo gets the capped amount.
- The meter pushes each hour's total to Dodo, keyed by account and hour, so a repeat push is ignored.

## Keys and safety

- Every key is limited to one bucket, and the bucket is the account's own: `drv-<id>` for an account, `drv-t-<teamId>` for a team (drive#371). iDrive e2 scopes a key to a bucket and never to a prefix, so the bucket is the boundary and the object layout stays `u/<id>/` inside it.
- A device key is limited to `/u/<id>/` inside that bucket, with capabilities `listFiles, readFiles, writeFiles, deleteFiles` (people can really delete; the file stays hidden 1 day in B2 because the drive uses rclone's default hide-not-delete, then sits in Hetzner's old-versions folder for 30 days).
- An agent key has the same prefix, without `deleteFiles`.
- A branch key is limited to `/u/<id>/.branches/<name>/`, without `deleteFiles`.
- A team key is limited to `/t/<teamId>/` inside `drv-t-<teamId>` (issue #20, drive#371), with `read_only` members holding list and read and `read_write` members holding write as well. No team role holds `deleteFiles`. Removing a member revokes their team keys at once, so the key stops working on the next request.
- An agent key, an s3 key and a branch key carry an hour, and no longer (issue #106). The api Worker renews the window on every request that proves the key is still held by something using it, so a connected tool never notices, and revoking the key stops renewal at once. What the hour is, stated exactly: an idle timeout. A key that nothing is using dies an hour after its last request, so one hour is the longest a leaked or copied credential stays useful on its own, and a holder who keeps using the key keeps it alive — the leak is bounded by your revocation, and the idle bound is what a copy outlives. A person's own device key is not given an expiry, and their device sign-in is unchanged. The renew route is behind the account gate, so a leaked storage key, which holds no device token, cannot restart its own hour.
- At the spending cap, the api Worker deletes each write-capable key and mints read-only ones. The mount picks up the new key at its next start, and the CLI restarts the mount. Uploads waiting in the cache stay on disk until the cap is raised.
- Account closing: all keys revoked at once; files deleted after 30 days, with an email at day 0 and day 25.

## Against the competitor, feature by feature (bar: match or beat)

Nish, 2026-09-29: "gotta build it better than the main competitor tho, at least match it". The competitor's claims from the competitor's site, read 2026-09-29.

| Competitor offers | Us | Verdict | Where |
|---|---|---|---|
| Mac and Linux; Windows "coming soon" | Mac and Linux; Windows later | Match | Steps 2, 3 |
| "Files open instantly", streamed, "zero bytes on disk" | rclone VFS streaming with a local cache | Match, to prove with the speed test below | Step 2 |
| Changes sync "in seconds" to every device | Upload about 5 s after save; other machines see it on the next listing | Match, to prove | Step 3 |
| Works with any app, no plugins | Plain mounted folder | Match | Steps 2, 3 |
| "Search 10x faster than Spotlight" | Nothing yet | **Gap** | Issue 18 |
| Public file links and upload requests | Nothing yet | **Gap** | Issue 19 |
| Every change is a version, nothing lost | Every save kept 1 day, then one a day for 30 days | **Gap** (the competitor keeps every version) | Step 8; keeping every version longer costs storage, so this is a deliberate trade |
| Fork a whole drive instantly "without copying a byte" | Branches by server-side copy (fast, but it copies) | **Gap** on huge folders | Step 7: measure a 10 GB branch; if it's slow, copy on first write instead. Measured 2026-10-02 (issue 157): a 6 GB file is one multipart copy (5 GiB is CopyObject's single-copy ceiling, so bigger files are `CreateMultipartUpload` + `UploadPartCopy` + `CompleteMultipartUpload`), 384 parts of 16 MiB, 81 s against a local MinIO and the same whole-object checksum at the branch path. The remaining limit is the per-file snapshot: 8,800 files fit one D1 row, 10,000 do not (issue 252 moves it out of the row) |
| Agents read and write the same files | Same, plus one-command setup for Claude, Codex, Gemini, Cursor and Kiro, sandbox connectors, agent undo and per-agent spending caps | **Beat** | Steps 4, 11; issue 13 |
| Teams: pooled storage, whole-drive sharing, member access | One team drive shared by several accounts, a role per member, removal that kills the key | Match | Issue 20: `t/<teamId>/` keys, `TEAM_ROLE_CAPABILITIES` (`workers/api/src/keyprovider.js`), `workers/api/src/teams.js` |
| SSO, audit, private cloud (Enterprise) | Not planned | Gap, fine for now | Later |
| $15 a month for 1 TB, full price even when part-full | 2¢ per GB on the biggest size in the last 30 days, never more than $15 per TB — $30 at 2 TB, $75 at 5 TB (a usual plan costs about the same at 1 TB and less above it, so the pitch is "pay only for what you use") | **Beat** | Step 6 |

**Speed test (in step 2's "done when"):** from a Mac over home broadband, open a 5 GB video and a 2 GB Blender file straight off the drive. The first frame or viewport must show within 3 s, scrubbing must not stall, and a 1 GB save must reach storage within 10 s. Run the same files on a the competitor trial side by side if a free trial exists (no card). Otherwise compare against the competitor's own words, "open instantly" and "in seconds". Record the times in the issue.

## Build steps

Every step is one issue, built by a queue worker and checked by a different model family, in a new product repo made at go time. Each step is done only when its check passes on real files, with the proof (paths, ids, timestamps) in the issue.

| # | Step | What gets built | Done when |
|---|---|---|---|
| 1 | Storage and keys | First, on iDrive e2's free 1 TB, check three things: keys limited to one folder, save and delete notifications, and average-not-peak monthly billing. If all pass, iDrive is primary and everything below uses its S3 API; if any fails, use B2. Then: B2 bucket with versioning, SSE-B2, 1-day lifecycle rule for hidden versions, event rule to the api Worker. Key minting in the api Worker. Measured 2026-10-03 (drive#173): notifications are the console's, not the bucket API's, and one folder is out — so the boundary became the bucket, one per customer, provisioned per account and keyed per bucket by the reseller API (drive#371, see below). The two answers a stock S3 stand-in can give, the one that needs a real month, and why the vendor's own answers come with #173, are in the section below. | An agent key's delete leaves a hidden version, `drive restore` brings it back, and the agent key can't read another user's folder. |
| 2 | Drive on one Mac | CLI writes the rclone config and a launchd login item; `rclone nfsmount` with the cache flags. | A 5 GB video starts playing before it has downloaded, and a file saved then followed by a reboot comes back intact. |
| 3 | Linux and two machines | systemd user unit for `rclone mount`. | A save on the Mac shows up on the Linux box, and a save on Linux shows up on the Mac. |
| 4 | `drive init` and agents | Device sign-in, agent detection, MCP registration for all five tools, skill notes. | On a clean Mac, one `drive init` and then a fresh Claude Code session lists and edits a file in the drive, and the same works in Codex. |
| 5 | Meter | Event intake with de-duplication, `file_versions`, hourly rollup, dl Worker byte counting, nightly reconciler. | One real account's GB-minutes for a whole day match B2's own storage report within 1%, and its download bytes match Cloudflare's analytics within 1%. |
| 6 | Billing and cap | Dodo meters and checkout, membership bill, cap enforcement with key swap, usage page. | A real account is charged the right amount for a real day, and a capped account goes read-only with no file lost and starts writing again once the cap is raised. |
| 7 | Branches | `branch`, `branches`, `diff`, `approve`, `discard`; server-side copy inside the drive's buckets (same bucket, same account: a branch is a copy of `u/<id>/…` at `u/<id>/.branches/<name>/…`). | An agent's branch is approved into the original folder; a second is discarded with the original untouched; an approve where the original changed stops and lists the file. |
| 8 | Backup and old versions | Nightly `rclone sync --backup-dir` to the Storage Box plus the 31-day purge, as one systemd timer; Hetzner restores in `drive restore`. | A file edited on day 1 and again on day 3 can be restored to its day-1 version from Hetzner on day 10 with a matching checksum; a file removed from B2 on purpose is restored from Hetzner; and a day-31 folder is gone. |
| 9 | Pricing page and sign-up | Web pages above, pricing copy from spec.md. | A new person signs up, installs, stores a file and sees the right cost on the usage page, on a phone and a desktop. |
| 11 | Connectors for agent sandboxes (after steps 3 and 4) | Two ways in, so the drive works inside boat.dev, E2B, Daytona, Vercel Sandbox, InstaCloud and similar: (a) a one-line install inside a sandbox that mounts the drive with a sandbox token (`drive init --token`), for sandboxes that allow FUSE; (b) a hosted MCP server on the api Worker, so any agent can use the drive with no mount at all, with a write guarded by `If-Match` so two agents never overwrite each other. Then a listing or template on each platform that has one (what each platform allows is in [Sandbox platforms](#sandbox-platforms-build-step-11)). | The same file is read and written from inside a real boat.dev sandbox (mount) and a real E2B sandbox (mount or hosted MCP), with the change visible on the Mac. |
| 10 | Swift File Provider app (later) | Native Finder drive to replace `rclone nfsmount` on Mac. | It passes steps 2 to 4 unchanged. |

Steps 1 to 4 can run with no billing at all, as a private test for Nish's own files. Steps 5 and 6 have to be finished before anyone else is charged.

## Build step 1: the storage answers (the stand-in, 2026-10-01)

Step 1 asks three questions of the storage provider before anything is built on it. Two of them are answered here against a stock S3-compatible stand-in, so the build is not blocked on a vendor account (Nish's direction, 2026-09-29: "do not wait for iDrive and never ask for its keys"); the third needs a real month and moves to #173 with the vendor's own answers. #173 ran against the real account on 2026-10-03 and all three answers are now measured: see [the real account](#build-step-1-on-the-real-idrive-e2-account-2026-10-03-drive173) below.

| Question | Answer on the stand-in | Where it was measured |
|---|---|---|
| Can a key be limited to one folder (prefix)? | **Yes.** The api Worker mints a key with an STS `AssumeRole` session policy whose only object resource is `arn:aws:s3:::<bucket>/u/<account-id>/*`. iDrive e2 has no `AssumeRole` at all, so the limit there is met a different way: the key is limited to a bucket, and the bucket is the account's own (drive#371, below). A key for one account is refused (`403 AccessDenied`) listing, reading and writing another account's folder, and an agent key is refused a delete. | `test/step1-storage.test.mjs`, "an agent key cannot list, read or write another account's folder" and "a delete leaves a hidden version…" |
| Are there event notifications for a file saved, hidden and deleted? | **Yes.** Bucket notifications fire `s3:ObjectCreated:*` and `s3:ObjectRemoved:*`; a delete on the versioned bucket arrives as `s3:ObjectRemoved:DeleteMarkerCreated` — the hidden event — and the file stays as a non-current version. | `test/step1-storage.test.mjs`, "a saved file produces an event that reaches the api Worker" |
| Is a month billed on average or peak storage? | **Not answerable without a month on the real provider.** It needs a billing period, not a stand-in. | measured on the real account, 2026-10-03: [Build step 1 on the real iDrive e2 account](#build-step-1-on-the-real-idrive-e2-account-2026-10-03-drive173) |

What the stand-in is: the last MinIO release (2025-07-23), in the archived Bitnami package, started by the test setup — the same `test/step1-storage.test.mjs` runs in CI's `verify` job (`npm test`) and on a developer's machine, and the setup is the only thing that decides which. MinIO's own downloads and Docker Hub images were withdrawn and its repository is archived, so the pinned last release is the stock server that has all three of versioning, lifecycle rules and bucket notifications. The `STORAGE_*` configuration — `STORAGE_ENDPOINT`, `STORAGE_REGION` and the master credential (`STORAGE_MASTER_ACCESS_KEY_ID`, `STORAGE_MASTER_SECRET_ACCESS_KEY`) — is the S3 path: it is what the stand-in and Backblaze B2 both mint against, with no code change, because both answer STS `AssumeRole` with a session policy. iDrive e2 is NOT configured that way for key minting: its STS refuses `AssumeRole` outright (measured 2026-10-03, drive#173), so on the primary vendor the same four settings still point the plain S3 client (reads, writes, provisioning) at iDrive, but the api mints a per-bucket key through the vendor's own reseller API instead, chosen by carrying `IDRIVE_E2_API_TOKEN` and no `STORAGE_*` (workers/api/src/index.js `keyProviderFor`, idrive-keys.js). See [the real account](#build-step-1-on-the-real-idrive-e2-account-2026-10-03-drive173) below.

The bucket: versioning on, a lifecycle rule that keeps a non-current ("hidden") version for one day and clears an abandoned delete marker, and bucket notifications pointed at the Worker's `POST /v1/events`. Drive#371 changed one thing about it: there is no longer one bucket for every customer, but one bucket per customer, provisioned per account with the same settings (versioning, `AES256`, the 1-day rule) and wired with no notification step, because iDrive's notifications are the console's (the next section). The answers above are read back from the bucket, not taken from the PUT's status. Server-side encryption is the one part of the bucket the stand-in does not carry: a stock S3 server refuses SSE-S3 with "KMS is not configured" (measured 2026-10-01). iDrive e2 takes the stock call: `AES256` was set on the real bucket and read back, so it is the table in the next section, not a missing vendor step.

## Build step 1 on the real iDrive e2 account (2026-10-03, drive#173)

The real account is the one behind the `idrive` rclone remote on this host (Nish saved it 2026-10-03 17:26Z): endpoint `https://s3.eu-west-3.idrivee2.com`, region `eu-west-3`, bucket `drive-prod`, and the master credential read from the VPS credential store (`~/.config/rclone/rclone.conf`, section `[idrive]`) as environment variables. The credential never enters this repo, a commit, a PR body or a log line. The bucket was created and configured through the same `workers/api/src/s3.js` the api Worker runs, and every setting below is read back from the bucket by `readBucketConfig`, not taken from a PUT's status:

| Bucket setting | Read back from `drive-prod` |
|---|---|
| Versioning | `Enabled` |
| Hidden-version lifecycle | `NoncurrentDays` `1`, `ExpiredObjectDeleteMarker` `true` |
| Server-side encryption | `SSEAlgorithm` `AES256` |
| Event notifications | none: `notificationArn` `""`, `notificationEvents` `[]` |

### Question 1: can a key be limited to one folder (prefix)? **No.**

The api Worker's own `POST /v1/keys` route, run against the real account, mints nothing:

```
mint device: status=400 {"error":"mint a scoped storage key failed with AccessDenied (HTTP 403): Generating temporary credentials not allowed for this request."}
mint agent:  status=400 {"error":"mint a scoped storage key failed with AccessDenied (HTTP 403): Generating temporary credentials not allowed for this request."}
```

Why, read off the endpoint's own STS (`Action=` in a form body, SigV4 with the master credential):

- `AssumeRole` → `403 AccessDenied`, with a session policy and without one. The vendor's STS FAQ lists `GetSessionToken` as the whole of it.
- `GetFederationToken` → `400 InvalidParameterValue: Unsupported action GetFederationToken`.
- `GetSessionToken` → `200`, and the credential it returns inherits the master key. That is the vendor's own wording: "temporary credentials that inherit permissions from your IDrive® e2 access keys".

So the nearest thing iDrive offers to a minted key is account-wide. Measured with a `GetSessionToken` credential, the three calls the stand-in refuses with `403 AccessDenied` all answer `200`: list `?prefix=u/acct-not-ours/`, `GET u/acct-not-ours/theirs.txt` (the body reads back), and `PUT u/acct-not-ours/theirs.txt`. The endpoint does not enforce the scope, so a key's scope on iDrive is a promise the api Worker makes rather than one storage refuses to break.

iDrive's own access-key model cannot carry the scope either: a console key is limited to chosen buckets (specific or all), a permission level (Read and write, Read only, Upload only) and an expiry — never to a prefix. The design's `u/<account-id>/` prefix has nothing to bind to.

### Question 2: are there event notifications for a file saved, hidden and deleted? **Yes — but the destination is the console's, not the bucket API's.**

- `GET /drive-prod?notification` answers `<NotificationConfiguration><IsAWSConfig>false</IsAWSConfig></NotificationConfiguration>`; `readBucketConfig` reads no ARN and no events.
- `PUT /drive-prod?notification` is refused for every destination shape tried: MinIO's `arn:minio:sqs::drive:webhook`, and a well-formed `arn:aws:sqs:eu-west-3:000000000000:drive-events`, both `400 InvalidArgument: A specified destination ARN does not exist or is not well-formed.` Nothing is stored either way.
- That is why `node --test test/step1-storage.test.mjs` with `DRIVE_STANDIN_*` pointed at iDrive dies inside `provisionBucket` (`S3Error: set the bucket event notifications failed with InvalidArgument (HTTP 400)`) before any sub-proof runs. A real-account run has to configure the bucket first and then run the proofs without the notification step, which is what the run below did.

The vendor's own path: a destination is registered in the e2 console (Settings → Event Notifications → Add Destination), and the only two kinds are an AWS SQS or SNS ARN — which needs an AWS credential and a Fetch ARN — and a webhook (Target URL, Signing Secret, batch size, extra headers, Test Rule). A bucket is then bound under Buckets → bucket → Event Notifications, with optional prefix and suffix filters and three event groups: Object Creation, Object Removal, Object Lifecycle.

What is **not** proven on iDrive: a saved file arriving at the Worker as an event. The delivery leg needs a destination registered in the console, which needs Nish's login, and a public URL, which needs the api Worker deployed (#342). What *is* proven is the intake: the Worker's own `POST /v1/events`, handed the event shape the vendor's docs describe and the real version id of the real save, answers `202 {"received":1,...}` and logs

```
[api] storage event s3:ObjectCreated:Put drive-prod/u/<account-id>/report.txt version=<the id the real save returned> at=2026-10-03T17:49:02.392Z
```

### Question 3: is a month billed on average or peak storage? **Neither: one figure per billing cycle, plus a 30-day storage minimum.**

The vendor's own words (idrive.com/e2, Pricing FAQ): "IDrive® e2 calculates the service charge based on the amount of total storage used during the billing cycle." The pricing page says the same with "active storage". A pay-as-you-go account is billed at the end of each 30-day cycle, and an "interim prorated charge" can land mid-cycle when usage rises sharply. So there is one storage figure per cycle, not a sample average and not a peak of daily readings.

The part that matters to the meter is the minimum: "IDrive® e2 enforces a minimum storage duration of 30 days", and an object deleted before day 30 "will be charged for the remaining days up to the 30th day as if the object was still stored" — the vendor calls that *Deleted Storage*, against *Active Storage* for what exists.

- A 1-day hidden-version rule caps retention, not cost. A delete inside the cycle reduces nothing on the bill: iDrive charges the deleted object's bytes to day 30. Step 5's reconciler reads a day's GB-minutes from `usage_minutes` and the provider's own bytes for the same account, and on this shape those two are not the same number for any day that carried deletes — so the gap has to be modelled, not read as drift. That is #364, because what the customer is billed for a delete is Nish's call.
- $5 per TB-month on the Veeam/MSP/Reseller plan ($6 pay-as-you-go), charged per TB, and under 1 TB is still charged the whole 1 TB. Downloads are free up to 3x the stored volume, then $10/TB (about $0.01 per GB). Ingress, deletion and API requests are free.

### What passed on the real bucket, and the verdict

Step 1's done-when has two halves. The hidden-version half passes on iDrive, measured on the real bucket: save `report.txt` (version `bfe496a6-ddd8-45a6-8288-364e6317ce09`), `DELETE` it (delete marker `ce7bdd7e-4c05-4a44-b024-ba152ee8b4bc`), and the version listing shows the marker as `latest=true deleteMarker=true size=0` with the save behind it as `latest=false deleteMarker=false size=36`; `GET ?versionId=<hidden version>` answers `200` with MD5 `ac955fc7aef49e7cda604ecabfa66d16`, the MD5 of the bytes saved.

The other half — a key that cannot read another account's folder — fails, and it is the question step 1 asks first. The verdict below stood until drive#371 answered the same question with the other boundary the vendor does carry: one bucket per customer, each key limited to its own bucket, which the storage server enforces itself. **iDrive e2 is primary storage** on that answer (drive#371, the next section). The B2 build (#363) is the standby, not the plan; what a delete inside a billing cycle costs the customer is #364, which is Nish's call and not this section's.

### Question 1, the answer that keeps iDrive primary: one bucket per customer (2026-10-04, drive#371)

iDrive e2 cannot scope a key to a folder. It can scope one to a bucket, which its own console and its reseller API both do: the chosen buckets (specific or all), a permission level (Read and write, Read only, Upload only), an expiry, and on the reseller path the flags `disable_delete_object` and `disable_delete_version` too. So the boundary moves from the prefix to the bucket, and the bucket is the account.

| Before (drive#173) | After (drive#371) |
|---|---|
| One bucket for everyone (`drive-prod`), each account's objects at `u/<account-id>/`, and the limit held only by the api Worker's session policy — which the vendor's STS refuses to mint, so a minted key is account-wide | One bucket per account, `drv-<account-id>`, one per team, `drv-t-<teamId>`. A key names its one bucket, so the storage server refuses the other accounts' objects, and a leaked key reaches one account's bucket and nothing else |
| The mint is an STS session the vendor refuses | The mint is the reseller API's `create_access_key`, which returns a long-lived pair scoped to that bucket |

What did not change, which is why this is the small fix: the object layout inside a bucket is still `u/<account-id>/…`, a branch still sits at `u/<account-id>/.branches/<name>/…`, and a team's files still sit at `t/<teamId>/…`. `src/files.js`, the event routes, the meter's folder split and the CLI paths are untouched, because the only thing that moved is the name of the bucket a key can reach.

Bucket provisioning, keys, revocation, and the two things the bucket makes easy:

- **The bucket is provisioned at the first mint that needs it**, not at sign-up, because the site Worker and the api Worker are separate Workers with no service binding between them and a cross-Worker hook would be a new failure mode between an account and its first key. The call is one idempotent `PUT` of the same settings — versioning, `AES256`, the 1-day hidden-version lifecycle — through the same `provisionBucket` the stand-in runs, and it needs a storage master credential, so a deployment that carries only the reseller token provisions nothing.
- **Keys are per bucket by construction.** A scope that names no bucket is refused rather than minted against every bucket the token can reach (`workers/api/src/idrive-keys.js`). The vendor has no token half to leak, so the mint answers with the pair only. An agent's key sets `disable_delete_version`, so its delete hides a file and `drive restore` still has the version behind the marker.
- **A revoke now stops the key.** The D1 store's revoke also withdraws the credential at the vendor (`remove_access_key`), so a revoked row is not a key the api still has to refuse, and a cap swap withdraws the old key before minting the read-only replacement (`workers/api/src/devices.js`).
- **Branch copies stay inside the bucket.** A branch key is limited to the account's own bucket and its `.branches/<name>/` folder, and the copy is the same server-side `CopyObject` / multipart copy the stand-in proved (issue #157), now within one bucket.

**Metering without events.** iDrive e2's notifications are the console's, not the bucket API's (the question-2 section above), so on the primary vendor there is no `/v1/events` to reconcile against. The meter keeps its shape and loses its feed: step 5's 04:00 UTC reconciler already walks each account's prefix and its version list, and that walk is per bucket now, one account each, so the reconciler reads `drv-<id>` and, for a team, `drv-t-<id>`. The day that has to be built is the vendor's own usage — `usage_stats` and `bucket_stats` through the same reseller API — booked into `usage_stats` beside the walk's own numbers, so a day can be read from either source and the gap between them is visible. That is a follow-up issue on this primary, not part of this change: the numbers this change moves (one bucket per account instead of one prefix inside a shared bucket) are already the shape the walk expects.

**Not measured on the real account:** the mint and the revoke need `IDRIVE_E2_API_TOKEN`, the reseller token, which is Nish's. Everything above is proven against the stand-in (`workers/api/test/idrive-keys.test.js`), and the real-account proof is a follow-up issue, not something this change waits for.

What #173 leaves behind in code: nothing. Every difference between the stand-in and the real account was configuration — endpoint, region, bucket, credential, and the bucket settings in the table above. What this change does is replace every line that deferred to this issue ("#173 checks the real vendor", "lands with iDrive e2 (issue #173)", "iDrive e2 replaces it") with the measurement: `workers/api/src/s3-keys.js`, `workers/api/src/s3.js`, `workers/api/src/index.js`, `workers/api/src/devices.js`, the two test headers, `docs/api.md`, `docs/benchmarks.md`, `docs/spec.md` and this section.

## Build step 5: the meter against a stock S3 stand-in (2026-10-02)

Build step 5's done-when is one number from each of two sources that share
nothing: a full day's GB-minutes from `usage_minutes`, and the storage
provider's own report of the same account's bytes. `test/step5-meter-standin.test.mjs`
runs it end to end against the same pinned stand-in build step 1 uses (the
last MinIO release), in CI's `verify` job and on a developer's machine, with
the endpoint, region, bucket and credentials read from `DRIVE_STANDIN_*` so
iDrive e2 is the same build with different values. It replaces the
`rclone serve s3` on a local folder this issue's text names, because rclone's
S3 server has no versioning and no event rules at all: it cannot produce a
hidden version, a delete marker or a notification, so the issue's own second
bullet is unanswerable without a server that has them. rclone serve s3 is
still the stand-in for the proofs that need no versioning
(`test/standin-search.test.mjs`, `test/two-mount-sync.test.mjs`).

What one run proves, with the real records it ran on (2026-10-02,
`node --test test/step5-meter-standin.test.mjs`, account
`acct_35f83f85a74ab6b1650a2c24eab6c3b9`):

- **A real file uploaded, replaced and read back through the stand-in.** A
  40 MB save (version `7c1cf71e-6d35-4fe3-9765-3e24a93f4d96`), an 8 MB edit
  over it (version `830568a0-86c2-40d1-b9b7-70d19bf3e5e3`, which hides the
  first), a 6 MB photo in a subfolder (version `679fc287-706e-403f-8b07-c19541a17d0f`)
  and its delete (delete-marker version `011d015c-decf-4168-b603-818a4829f127`),
  each call signed with the account's own scoped key from the api Worker's
  `POST /v1/keys`.
- **The provider's own event rule, pointed at the Worker.** Four webhook
  deliveries, each accepted (202), each carrying `Authorization: Bearer <the
  rule's token>` and no `x-drive-event-token`, and each landing as a version
  row without any replay.
- **The provider's own report.** `ListObjectVersions` on the account's
  prefix: 6 000 000 bytes hidden at the marker, 8 000 000 live, 40 000 000
  hidden when the edit began.
- **The day.** `2026-10-01T07:00Z` to `2026-10-02T07:00Z`, 24 closed UTC
  hours, the hourly trigger fired once per hour with its own
  `scheduledTime` (`runMeterCron`, the Cron Trigger's own function):
  **3.04 GB-minutes metered, 3.04 GB-minutes from the provider's own report,
  drift 0.0000%** (the bar is 1%).

Two things the run tells, both now the code's shape:

1. **The bucket sends a bearer token, not a header of its own.** Measured
   against the pinned stand-in on 2026-10-02: MinIO's notify webhook puts
   `Bearer <MINIO_NOTIFY_WEBHOOK_AUTH_TOKEN_*>` in `Authorization` and has no
   variable to set a header of its own, so a rule configured the vendor's own
   way arrives with no `x-drive-event-token`. `POST /api/storage-events`
   therefore accepts the same secret from either header
   (`bearerToken`, src/meter.js); the endpoint is still closed — a missing or
   wrong token is still the 401 it always was, and the proof shows it.
2. **A provider's event never says what it replaced.** The edit's
   `ObjectCreated:Put` carries no hide for the version it replaced, and a
   delete's marker is a version of its own, so the meter learns a hide from
   the provider's own version listing through the nightly reconciler (#59).
   The run above reports `hidden=2 marked=1` before the day is rolled.

Both delivery shapes are read by one mapping: an S3 `Records` envelope, a
bare list of records, and the single record a bucket bubbles to a
record-endpoint ARN all go through `notificationRecord` (src/meter.js), which
takes the provider's own field names (`key`, `size`, `versionId`, `eventTime`,
`eventName`) and hands `validateEvent` the intake's. A record the mapping does
not recognise is passed through unchanged, so a malformed record in a batch
still fails as itself and the good records beside it are stored.

## How we know it is up (the outage alert)

North star "Reliable" (Nish, 2026-09-30): we hear about an outage before customers do. The outside monitor is issue #36: one free, stock external uptime monitor (UptimeRobot or Better Stack free tier, no card) checking the URLs below every few minutes, alerting Nish by phone push or email. The site origin is pinned in `src/seo.js` (`SITE.origin`, `https://storagebun.com` today) and `test/seo.test.mjs` holds it there, so this table names the source rather than a second copy.

| URL | What it is | Built |
|---|---|---|
| `/` on the site origin | The landing page, the site's front door, and the page every customer notices first. | today (static asset) |
| `/api/health` on the site Worker | The Worker's own health endpoint (#96, `src/health.js`). 200 with `{"ok":true}` only when the Worker can reach each bound D1 database and its asset layer; 503 naming the binding that did not answer. Public, no account data, `Cache-Control: no-store`, bounded so a hung dependency cannot hang the poll. | #96 |
| `/v1/health` on the api Worker | The API's own health route, so a drive that is mounted but cannot reach the API is caught. | with the api Worker (build step 4, #5) |
| the download host | The host downloads stream from, so a broken download path is caught. | with the dl Worker (build step 5, #6) |

`/api/health` is deliberately not a "the Worker woke up" ping: it does a trivial read (`SELECT 1`) on each bound D1 database and a `HEAD` fetch through the asset layer, so a database or a page that will not serve is a 503 while the isolate is still alive — which is the difference between an alert and a false all-clear. It names the failing binding in the body (configuration the operator already has; never a secret, a query or a stack) and reports one name, the first failure.

## Open questions (not blocking the spec)

- **B2 delete events.** I confirmed the "file created" event names in Backblaze's API docs on 2026-09-29. I did not confirm the names for hidden and deleted files. The nightly reconciler covers this either way; step 5 checks it.
- **B2 key limit.** One key per device, agent and branch could mean thousands of keys. Backblaze's key limit was not checked; check it before step 1.
- **Cloudflare terms for a download proxy.** Checked 2026-09-30, before building the dl Worker (step 5). The answer: streaming reads through a Worker is allowed on the self-serve plan, with two things to hold to. (1) **Response size is not limited by Cloudflare.** The Workers limits page says "Cloudflare does not enforce response body size limits"; the 100 MB figure is the *request* body cap on Free and Pro, so it applies to uploads and not to a download proxy. A CDN cache limit (512 MB Free/Pro, 5 GB Enterprise) applies only if a response is cached, which a per-account download is not. (2) **The old non-HTML clause is gone.** The Self-Serve Subscription Agreement (last updated 2025-09-12, read 2026-09-30) no longer carries the "video or a disproportionate amount of non-HTML content" restriction; it has no "non-HTML" or "disproportionate" language at all, and customer content is covered by 2.5 with acceptable use by 2.7. The one real constraint is CPU time, not bandwidth: streaming a body costs almost no CPU (waiting on the origin does not count), but the Workers Free plan allows 10 ms of CPU per request, so the dl Worker must pass the body through with `response.body`, never buffer or transform it, and its CPU use has to be measured against that ceiling. If it does not fit, the paid Workers plan is $5/month - money, so Nish's call. Cloudflare can change its terms, so re-check before launch.
- **Mount while read-only.** Proven step 6 (drive #229): a write-capable device key mounts → at the cap the api Worker swaps it for a real MinIO scoped read-only key (same row id, `cappedFrom = [list,read,write,delete]`) and the CLI restarts the mount on the same mount dir + VFS cache → rclone refuses writes (`403 AccessDenied`) via the session policy, no file is lost, and a write-in-flight inside rclone's `--vfs-write-back 5s` window is held in the cache and is `null` in storage. After the cap is raised the write key is minted first, the read-only key revoked, the mount restarts, and the pending upload lands. The proof is `test/integration/cap-mount-readonly.test.mjs` against a real `rclone mount` over the MinIO stand-in with the real D1 device store and the real key provider (iDrive e2 cannot mint scoped keys, measured `2026-10-03` in `workers/api/src/s3-keys.js`; B2 is not provisioned for a local run).
- **Missed nights.** If the backup timer misses a night, that night's old versions are lost and the purge skips a folder. The timer's failure must alert (unit failure is already watched on the VPS).
- **Business tier** (SSO, SOC 2, pooled bill): after v1, not specced here.

## Stock tools used, nothing hand-built beyond product logic

rclone (mount, nfsmount, server-side copy, sync), B2 versioning, lifecycle rules, scoped keys and event notifications, Cloudflare Workers, D1 and Cron Triggers, Dodo usage billing and hosted portal, the MCP filesystem server, each agent tool's own `mcp add`, launchd, systemd timers. Hand-written: the CLI, the api and dl Workers, the meter and reconciler logic, and the web pages.
