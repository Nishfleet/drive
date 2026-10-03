# SpaceFS clone: build spec

> **Status note (2026-10-02):** this is the historical build plan. The code and the open issues are the source of truth, and where they differ the code wins. Shipped work is listed in `docs-site/changelog.md`.

Written 2026-09-29, on Nish's ask ("lets get to speccing?"). This turns the build plan in `spec.md` into what each part does, the commands and screens, the data model, and the steps in detail. `spec.md` still holds the why: prices, rivals and the pressure test.

**Status: building since 2026-09-29** (Nish: "lets go then"). Issues #2 to #15 in this repo; spending money (storage accounts, Storage Box) still needs Nish.

## Decisions this spec uses

| Decision | Value | State |
|---|---|---|
| Primary storage | iDrive e2 at $5/TB-month (reseller plan) if it passes build step 1; otherwise Backblaze B2. The spec says B2 below; swap names if iDrive wins | Nish, 2026-09-29 |
| Price | 2¢ per GB-month, billed by the minute; the monthly bill never passes max($12, $8 × peak TB), TB measured to the GB. B2 fallback: $10/TB | Nish, 2026-09-30 |
| Billing unit | **Per minute** (not per second). The headline stays "2¢ per GB a month, billed by the minute". Never advertise a per-minute price. | Nish leaning, 2026-09-29; coordinator and I agree |
| Minimum per file | 1 hour | Asked 2026-09-29; default **yes** until Nish answers |
| Free credit | $1 of storage free every month (about 50 GB), no card needed to start. A card is needed only to go past it. Shown in dollars, never as "credits" or points | Nish asked for a free starter credit, 2026-09-29 (from the Higgsfield research). Abuse cost is capped: a throwaway account can hold at most 50 GB, about 35¢ a month to us |
| Old versions | **Free to the user.** Kept 1 day in B2, then 30 days on the Hetzner Storage Box (about $2.3/TB against B2's $6.95) | Nish, 2026-09-29 ("move it to hetzner for 30 days"). Catch: if a file is saved several times in one day, only that day's last version reaches Hetzner |
| Downloads | Free up to 3x average stored data each month, then 1¢/GB | spec.md |
| Spending cap | Required at sign-up (default $12, the ceiling's floor; Nish via #39, 2026-09-30). At the cap the drive goes read-only; nothing is deleted. The cap counts min(metered so far, ceiling), not the raw meter, so a default account can never be cut off at or under 1.5 TB peak — the ceiling holds the counted usage at $12 exactly where the default cap sits | #39 decision, 2026-09-30 |
| Platforms | macOS and Linux. No Windows in v1 | spec.md |
| Headline price | "2¢ per GB, billed by the minute" with the ceiling "never more than $12 a TB, then $8" under it (the $8 is iDrive; see Bill ceiling for the B2 fallback) | Nish, 2026-09-30 |
| Bill ceiling ("never pay more than the plan") | Billed by the minute, but the monthly bill never passes the peak ceiling: **min(metered, max($12, $8 × peak TB))**, TB measured to the GB (Nish, 2026-09-30, issue #29). $8 a TB holds only on iDrive at about $5/TB; if iDrive fails step 1 and we use B2 ($6.95/TB), the ceiling rate goes to $10/TB and the cap is `max($12, $10 × peak TB)` — so the "$8" in the headline is an iDrive figure and must change with the primary. Inside the ceiling you pay 2¢/GB. Examples: 800 GB = $12; 1.3 TB = $12; 1.6 TB = $12.80; 2 TB = $16, against Space $27; 5 TB = $40, against Space $63. Automatic, no plan switch. Cost is about $5/TB on iDrive, so margin is about 37% at the $8 a TB ceiling before payment fees and the free old-version copies (about $2.3/TB on Hetzner), which take that to about 9% and can break even for heavy editors; margin under the $12 plateau is better. The ceiling also prices below the 1.5¢ hard floor: $12 for 1 TB is 1.2¢/GB and $8 a TB above 1.5 TB is 0.8¢/GB. Nish set both; the floor applies to the metered rate, not the cap. Headline: "2¢ per GB, billed by the minute. Never more than $12 a TB, then $8." | Nish, 2026-09-30 (bill = min(metered, max($12, $8 × peak TB)); B2 fallback $10/TB); issue #29 |
| Company tier | "Business": same storage price, plus single sign-on, SOC 2 report, one company bill split by team, and priority support. On the pricing page from day one as "Talk to us"; built after v1 | Nish, 2026-09-29 |
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
2. **The mount.** Stock rclone. Mac: `rclone nfsmount` (uses macOS's built-in NFS, so no macFUSE). Linux: `rclone mount`. Both with `--vfs-cache-mode full --vfs-write-back 5s --vfs-cache-max-size 20G --vfs-read-ahead 128k --b2-download-url https://dl.<domain>`, and both with `--dir-cache-time 5s`: S3 sends no change notifications, so without it the other machine waits out rclone's 5-minute directory cache before it sees a save (measured 2026-09-30 against a local S3 stand-in with two mounts: 5.0 s with the flag, still absent after 60 s without it, so the counterfactual is measured, not assumed). `--vfs-read-ahead 128k` is the stock extra disk read-ahead with cache-mode full (issue #227). `--vfs-refresh` is not passed: rclone would walk the whole tree at mount start, which is the wrong trigger for "prefetch the next folder" and delays mount-ready. Child listings after a folder is listed have no rclone flag, so `drive prefetch` (a second login item, Nice 19) does only that leftover work. Kept running by launchd (Mac) or a systemd user unit (Linux), both written by the CLI.
3. **api Worker** (Cloudflare Workers + D1). Accounts, device sign-in, key minting, spending cap, branch bookkeeping, the web pages. Holds the B2 master key as a Worker secret; nothing else does.
4. **dl Worker** (Cloudflare Workers). Sits on the download hostname. Streams B2 reads through Cloudflare (B2 to Cloudflare egress is free) and adds the bytes to the user's download counter, found from the `/u/<id>/` path.
5. **Meter** (Worker Cron Trigger, hourly). Turns file events into GB-minutes per user, pushes usage to Dodo, and flips accounts to read-only at their cap. The schedule's reason: Dodo needs periodic usage reports.
6. **Reconciler** (Worker Cron Trigger, nightly). Lists each user's file versions in B2 and fixes any event the meter missed. The schedule's reason: B2 event delivery can drop or repeat events.
7. **Backup and old versions.** Nightly `rclone sync b2:bucket box:current --backup-dir box:old/<today>` from B2 to a Hetzner Storage Box, run as a systemd timer on the netcup VPS (default runner; change at go time if the VPS is a bad fit). rclone's `--backup-dir` moves any file that changed or was deleted into that day's folder instead of throwing it away, so `box:old/` holds 30 days of old versions. The same timer runs `rclone purge box:old/<31 days ago>` to drop the oldest day. Restores from Hetzner are copied back into B2 by the same runner.
8. **Billing.** Dodo usage meters, hosted checkout and customer portal. We store no card data.

## Commands (v1)

| Command | What it does |
|---|---|
| `drive init` | Sign in (opens the browser for a device code), make the drive folder (`~/Drive`), start the mount, find installed agent tools and connect each one. Safe to run again. |
| `drive status` | Mounted or not, files waiting to upload, this month's cost so far, cap |
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
| `drive uninstall` | Stop the mount and remove the login item that starts it at the next login. The files in the drive folder, the key and the config are kept — `drive logout` is the command that revokes the key and deletes the config. |

## Screens (v1)

Web pages are served by the api Worker. There is no Mac app in v1; Finder is the app.

| Screen | What's on it |
|---|---|
| Sign in | Email one-time link, or Google or GitHub. No card asked |
| Device approval | "Approve `drive` on Nish's MacBook?" with the code from the terminal |
| Usage | One "you saved" line, whose copy varies by month type (decided #39, 2026-09-30): a capped month (metered > ceiling) shows "Our price cap saved you $X" with X = metered − bill; an uncapped month shows "You paid $X less than a flat plan" with X = ceiling − bill. Hidden when the figure is ≤ 0, and on a month with no bill at all (an empty drive is not a saving against anything). Then stored GB (line chart, last 30 days), this month's cost, downloads out of the free 3x, cap slider |
| Devices and agents | Every key: device or agent tool, last used, revoke button |
| Billing | Dodo's hosted portal: card, invoices, the free $1 shown as a dollar line |
| Branches | Each branch: agent, files changed, approve or discard |

Pricing page: the headline is the rate, "2¢ per GB, billed by the minute", with the ceiling under it — issue #23's finish line renders it "Never more than $12 a TB, and $8 a TB once you pass 1.5 TB" — then "$1 free every month, no card needed"; worked examples ("500 GB for 3 days: about $1, then $0 after the $1", "800 GB kept all month: $12 of storage, $11 billed", "2 TB kept all month: $16 of storage, $15 billed (Space $27)", "5 TB kept all month: $40 of storage, $39 billed (Space $63)") — each the capped total, min(metered, ceiling), less the $1 free (#76), with the storage figure beside it and Space's, which this file's Bill ceiling decision already fixes as $27 and $63; a Business column with "Talk to us". No per-minute price, no credit units, no "unlimited". The page no longer carries the "about $20 per TB a month" headline, which was Space's price in our voice (issue #23's rework). The ceiling numbers and the canonical ceiling sentences live in `src/pricing.js` (PRICE), the single price module `src/seo.js` reads (issue #23 folded the metadata's copy into it): the page copy, the meta tags and llms.txt are all gated against that config, `src/billing.js`'s `monthBillCents()` is the one function that turns those numbers into dollars, and `test/pricing-copy.test.mjs` builds its expectations from that config and that function, so copy that drifts from the numbers fails CI.

## Agent tools

`drive init` checks which tools are installed and connects each one. Each gets its own B2 key: read and write, limited to the user's folder, with **no `deleteFiles`**. An agent's delete therefore only hides a file, and `drive restore` brings it back.

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
- Monthly cost = total GB-minutes ÷ 43,800 (minutes in an average month) × 2¢.
- Downloads: bytes counted by the dl Worker. Anything above 3x the average stored GB that month is billed at 1¢/GB.
- The free $1 comes off each month. Without a card, writes stop at $1 of usage (the account's cap is $1 until a card is added).
- The monthly invoice and usage page show one "you saved" line, with the baseline chosen by month type (decided #39, 2026-09-30; Nish can overrule). Capped month (metered > ceiling): saved = metered − bill, copy "Our price cap saved you $X". Uncapped month: saved = ceiling − bill, copy "You paid $X less than a flat plan". Hidden when the figure is 0 or less, and on a month with no bill (an empty drive costs $0 on every plan, so there is nothing to have saved). The bill itself is min(metered, ceiling); the ceiling is applied at invoice time, so Dodo gets the capped amount.
- The meter pushes each hour's total to Dodo, keyed by account and hour, so a repeat push is ignored.

## Keys and safety

- A device key is limited to `/u/<id>/`, with capabilities `listFiles, readFiles, writeFiles, deleteFiles` (people can really delete; the file stays hidden 1 day in B2 because the drive uses rclone's default hide-not-delete, then sits in Hetzner's old-versions folder for 30 days).
- An agent key has the same prefix, without `deleteFiles`.
- A branch key is limited to `/u/<id>/.branches/<name>/`, without `deleteFiles`.
- A team key is limited to `/t/<teamId>/` (issue #20), with `read_only` members holding list and read and `read_write` members holding write as well. No team role holds `deleteFiles`. Removing a member revokes their team keys at once, so the key stops working on the next request.
- At the spending cap, the api Worker deletes each write-capable key and mints read-only ones. The mount picks up the new key at its next start, and the CLI restarts the mount. Uploads waiting in the cache stay on disk until the cap is raised.
- Account closing: all keys revoked at once; files deleted after 30 days, with an email at day 0 and day 25.

## Against Space, feature by feature (bar: match or beat)

Nish, 2026-09-29: "gotta build it better than spacefs tho, at least match it". Space's claims from https://spacefs.com, read 2026-09-29.

| Space offers | Us | Verdict | Where |
|---|---|---|---|
| Mac and Linux; Windows "coming soon" | Mac and Linux; Windows later | Match | Steps 2, 3 |
| "Files open instantly", streamed, "zero bytes on disk" | rclone VFS streaming with a local cache | Match, to prove with the speed test below | Step 2 |
| Changes sync "in seconds" to every device | Upload about 5 s after save; other machines see it on the next listing | Match, to prove | Step 3 |
| Works with any app, no plugins | Plain mounted folder | Match | Steps 2, 3 |
| "Search 10x faster than Spotlight" | Nothing yet | **Gap** | Issue 18 |
| Public file links and upload requests | Nothing yet | **Gap** | Issue 19 |
| Every change is a version, nothing lost | Every save kept 1 day, then one a day for 30 days | **Gap** (Space keeps every version) | Step 8; keeping every version longer costs storage, so this is a deliberate trade |
| Fork a whole drive instantly "without copying a byte" | Branches by server-side copy (fast, but it copies) | **Gap** on huge folders | Step 7: measure a 10 GB branch; if it's slow, copy on first write instead. Measured 2026-10-02 (issue 157): a 6 GB file is one multipart copy (5 GiB is CopyObject's single-copy ceiling, so bigger files are `CreateMultipartUpload` + `UploadPartCopy` + `CompleteMultipartUpload`), 384 parts of 16 MiB, 81 s against a local MinIO and the same whole-object checksum at the branch path. The remaining limit is the per-file snapshot: 8,800 files fit one D1 row, 10,000 do not (issue 252 moves it out of the row) |
| Agents read and write the same files | Same, plus one-command setup for Claude, Codex, Gemini, Cursor and Kiro, sandbox connectors, agent undo and per-agent spending caps | **Beat** | Steps 4, 11; issue 13 |
| Teams: pooled storage, whole-drive sharing, member access | One team drive shared by several accounts, a role per member, removal that kills the key | Match | Issue 20: `t/<teamId>/` keys, `TEAM_ROLE_CAPABILITIES` (`workers/api/src/keyprovider.js`), `workers/api/src/teams.js` |
| SSO, audit, private cloud (Enterprise) | Not planned | Gap, fine for now | Later |
| $15 a month for 1 TB, full price even when part-full | 2¢ per GB by the minute; the monthly bill never passes max($12, $8 × peak TB) — $16 at 2 TB, $40 at 5 TB (Space charges $15 + $12 flat per extra TB, even when part-full) | **Beat** | Step 6 |

**Speed test (in step 2's "done when"):** from a Mac over home broadband, open a 5 GB video and a 2 GB Blender file straight off the drive. The first frame or viewport must show within 3 s, scrubbing must not stall, and a 1 GB save must reach storage within 10 s. Run the same files on a Space trial side by side if a free trial exists (no card). Otherwise compare against Space's own words, "open instantly" and "in seconds". Record the times in the issue.

## Build steps

Every step is one issue, built by a queue worker and checked by a different model family, in a new product repo made at go time. Each step is done only when its check passes on real files, with the proof (paths, ids, timestamps) in the issue.

| # | Step | What gets built | Done when |
|---|---|---|---|
| 1 | Storage and keys | First, on iDrive e2's free 1 TB, check three things: keys limited to one folder, save and delete notifications, and average-not-peak monthly billing. If all pass, iDrive is primary and everything below uses its S3 API; if any fails, use B2. Then: B2 bucket with versioning, SSE-B2, 1-day lifecycle rule for hidden versions, event rule to the api Worker. Key minting in the api Worker. The two answers a stock S3 stand-in can give, the one that needs a real month, and why the vendor's own answers come with #173, are in the section below. | An agent key's delete leaves a hidden version, `drive restore` brings it back, and the agent key can't read another user's folder. |
| 2 | Drive on one Mac | CLI writes the rclone config and a launchd login item; `rclone nfsmount` with the cache flags. | A 5 GB video starts playing before it has downloaded, and a file saved then followed by a reboot comes back intact. |
| 3 | Linux and two machines | systemd user unit for `rclone mount`. | A save on the Mac shows up on the Linux box, and a save on Linux shows up on the Mac. |
| 4 | `drive init` and agents | Device sign-in, agent detection, MCP registration for all five tools, skill notes. | On a clean Mac, one `drive init` and then a fresh Claude Code session lists and edits a file in the drive, and the same works in Codex. |
| 5 | Meter | Event intake with de-duplication, `file_versions`, hourly rollup, dl Worker byte counting, nightly reconciler. | One real account's GB-minutes for a whole day match B2's own storage report within 1%, and its download bytes match Cloudflare's analytics within 1%. |
| 6 | Billing and cap | Dodo meters and checkout, $1 credit after card, cap enforcement with key swap, usage page. | A real account is charged the right amount for a real day, and a capped account goes read-only with no file lost and starts writing again once the cap is raised. |
| 7 | Branches | `branch`, `branches`, `diff`, `approve`, `discard`; server-side copy inside B2. | An agent's branch is approved into the original folder; a second is discarded with the original untouched; an approve where the original changed stops and lists the file. |
| 8 | Backup and old versions | Nightly `rclone sync --backup-dir` to the Storage Box plus the 31-day purge, as one systemd timer; Hetzner restores in `drive restore`. | A file edited on day 1 and again on day 3 can be restored to its day-1 version from Hetzner on day 10 with a matching checksum; a file removed from B2 on purpose is restored from Hetzner; and a day-31 folder is gone. |
| 9 | Pricing page and sign-up | Web pages above, pricing copy from spec.md. | A new person signs up, installs, stores a file and sees the right cost on the usage page, on a phone and a desktop. |
| 11 | Connectors for agent sandboxes (after steps 3 and 4) | Two ways in, so the drive works inside boat.dev, E2B, Daytona, Vercel Sandbox, InstaCloud and similar: (a) a one-line install inside a sandbox that mounts the drive with a sandbox token (`drive init --token`), for sandboxes that allow FUSE; (b) a hosted MCP server on the api Worker, so any agent can use the drive with no mount at all, with a write guarded by `If-Match` so two agents never overwrite each other. Then a listing or template on each platform that has one (what each platform allows is in [Sandbox platforms](#sandbox-platforms-build-step-11)). | The same file is read and written from inside a real boat.dev sandbox (mount) and a real E2B sandbox (mount or hosted MCP), with the change visible on the Mac. |
| 10 | Swift File Provider app (later) | Native Finder drive to replace `rclone nfsmount` on Mac. | It passes steps 2 to 4 unchanged. |

Steps 1 to 4 can run with no billing at all, as a private test for Nish's own files. Steps 5 and 6 have to be finished before anyone else is charged.

## Build step 1: the storage answers (the stand-in, 2026-10-01)

Step 1 asks three questions of the storage provider before anything is built on it. Two of them are answered here against a stock S3-compatible stand-in, so the build is not blocked on a vendor account (Nish's direction, 2026-09-29: "do not wait for iDrive and never ask for its keys"); the third needs a real month and moves to #173 with the vendor's own answers, which #173 also reads off iDrive e2 as a configuration change.

| Question | Answer on the stand-in | Where it was measured |
|---|---|---|
| Can a key be limited to one folder (prefix)? | **Yes.** The api Worker mints a key with an STS `AssumeRole` session policy whose only object resource is `arn:aws:s3:::<bucket>/u/<account-id>/*`. A key for one account is refused (`403 AccessDenied`) listing, reading and writing another account's folder, and an agent key is refused a delete. | `test/step1-storage.test.mjs`, "an agent key cannot list, read or write another account's folder" and "a delete leaves a hidden version…" |
| Are there event notifications for a file saved, hidden and deleted? | **Yes.** Bucket notifications fire `s3:ObjectCreated:*` and `s3:ObjectRemoved:*`; a delete on the versioned bucket arrives as `s3:ObjectRemoved:DeleteMarkerCreated` — the hidden event — and the file stays as a non-current version. | `test/step1-storage.test.mjs`, "a saved file produces an event that reaches the api Worker" |
| Is a month billed on average or peak storage? | **Not answerable without a month on the real provider.** It needs a billing period, not a stand-in. | moves to #173 |

What the stand-in is: the last MinIO release (2025-07-23), in the archived Bitnami package, started by the test setup — the same `test/step1-storage.test.mjs` runs in CI's `verify` job (`npm test`) and on a developer's machine, and the setup is the only thing that decides which. MinIO's own downloads and Docker Hub images were withdrawn and its repository is archived, so the pinned last release is the stock server that has all three of versioning, lifecycle rules and bucket notifications. iDrive e2 replaces it by setting `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_BUCKET` and the master credential (`STORAGE_MASTER_ACCESS_KEY_ID`, `STORAGE_MASTER_SECRET_ACCESS_KEY`), with no code change.

The bucket: versioning on, a lifecycle rule that keeps a non-current ("hidden") version for one day and clears an abandoned delete marker, and bucket notifications pointed at the Worker's `POST /v1/events`. The answers above are read back from the bucket, not taken from the PUT's status. Server-side encryption is the one part of the bucket the stand-in does not carry: a stock S3 server refuses SSE-S3 with "KMS is not configured" (measured 2026-10-01), so SSE-B2 is set on the real bucket with the vendor in #173, where the rest of that bucket's configuration lands too.

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

North star "Reliable" (Nish, 2026-09-30): we hear about an outage before customers do. The outside monitor is issue #36: one free, stock external uptime monitor (UptimeRobot or Better Stack free tier, no card) checking the URLs below every few minutes, alerting Nish by phone push or email. The site origin is pinned in `src/seo.js` (`SITE.origin`, `https://drive-pricing.nishant345.workers.dev` today) and `test/seo.test.mjs` holds it there, so this table names the source rather than a second copy.

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
- **Mount while read-only.** It is unverified whether rclone keeps waiting uploads safely when its key is swapped for a read-only one. Step 6 proves it.
- **Missed nights.** If the backup timer misses a night, that night's old versions are lost and the purge skips a folder. The timer's failure must alert (unit failure is already watched on the VPS).
- **Business tier** (SSO, SOC 2, pooled bill): after v1, not specced here.

## Stock tools used, nothing hand-built beyond product logic

rclone (mount, nfsmount, server-side copy, sync), B2 versioning, lifecycle rules, scoped keys and event notifications, Cloudflare Workers, D1 and Cron Triggers, Dodo usage billing and hosted portal, the MCP filesystem server, each agent tool's own `mcp add`, launchd, systemd timers. Hand-written: the CLI, the api and dl Workers, the meter and reconciler logic, and the web pages.
