# SpaceFS clone: build spec

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
| Spending cap | Required at sign-up (default $10). At the cap the drive goes read-only; nothing is deleted. Note the tension with the ceiling: the floor is $12, so a default $10 cap stops writes before the advertised ceiling is reachable, and the cap counts the uncapped hourly meter while the ceiling applies only at invoice time. Whichever the cap should track is an open pricing question (issue #39) | spec.md |
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
2. **The mount.** Stock rclone. Mac: `rclone nfsmount` (uses macOS's built-in NFS, so no macFUSE). Linux: `rclone mount`. Both with `--vfs-cache-mode full --vfs-write-back 5s --vfs-cache-max-size 20G --b2-download-url https://dl.<domain>`. Linux also mounts with `--dir-cache-time 5s`: S3 sends no change notifications, so without it the other machine waits out rclone's default 5-minute directory cache before it sees a save (measured 2026-09-30 against a local S3 stand-in: 5 s with the flag, still absent after 60 s without). Kept running by launchd (Mac) or a systemd user unit (Linux), both written by the CLI.
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
| `drive logout` | Unmount, delete this device's key and local config |

## Screens (v1)

Web pages are served by the api Worker. There is no Mac app in v1; Finder is the app.

| Screen | What's on it |
|---|---|
| Sign in | Email one-time code, or Google or GitHub. No card asked |
| Device approval | "Approve `drive` on Nish's MacBook?" with the code from the terminal |
| Usage | "You saved $X" line: what the ceiling for your peak (max($12, $8 × peak TB)) would have cost, against what you paid. Shown only when it's a real saving. Then stored GB (line chart, last 30 days), this month's cost, downloads out of the free 3x, cap slider |
| Devices and agents | Every key: device or agent tool, last used, revoke button |
| Billing | Dodo's hosted portal: card, invoices, the free $1 shown as a dollar line |
| Branches | Each branch: agent, files changed, approve or discard |

Pricing page: the rate line "2¢ per GB, billed by the minute" with the ceiling "never more than $12 a TB, then $8" under it, then "$1 free every month, no card needed"; worked examples ("500 GB for 3 days: about $1", "2 TB kept all month: $16" — the capped total, $40 metered capped at $16, not the uncapped meter); a Business column with "Talk to us". No per-minute price, no credit units, no "unlimited". The ceiling numbers and the two canonical ceiling sentences live in `src/pricing.js`, and `test/pricing-copy.test.mjs` builds its expectations from that config, so page copy that drifts from the numbers fails CI.

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

Each tool also gets a short skill note: where the drive is, that deletes can be undone, and to use `drive branch` before large edits. Exact command syntax is checked against each tool's current docs in build step 4.

## Data model (D1)

| Table | Columns | Notes |
|---|---|---|
| `accounts` | id, email, created_at, dodo_customer_id, card_added_at, cap_cents, state (`active` / `read_only` / `closed`) | `read_only` once the cap is hit |
| `devices` | id, account_id, name, kind (`device` / `agent` / `s3` / `branch`), b2_key_id, capabilities, prefix, created_at, last_seen_at, revoked_at | The B2 secret is shown once to the device, never stored |
| `file_versions` | account_id, b2_file_id, path, size_bytes, created_at, hidden_at, deleted_at | One row per B2 version; the meter's source of truth |
| `usage_minutes` | account_id, hour, gb_minutes_live, download_bytes | Rolled up hourly |
| `billing_pushes` | account_id, hour, dodo_event_id, amount_units, pushed_at | Stops double-charging if a push retries |
| `branches` | id, account_id, name, source_prefix, branch_prefix, created_at, snapshot (JSON path to size and modified time), state (`open` / `approved` / `discarded`) | The snapshot finds clashes at approve time |
| `events_seen` | b2_event_id, received_at | Drops duplicate B2 events |

## How the money is worked out

- Each file version is billed from `created_at` until `hidden_at` (when it's replaced or deleted). Old versions are free to the user: B2 keeps them 1 day and Hetzner keeps them 30, and we absorb that cost.
- GB-minutes = size in GB × whole minutes stored, with at least 60 minutes per version (the 1-hour minimum).
- Monthly cost = total GB-minutes ÷ 43,800 (minutes in an average month) × 2¢.
- Downloads: bytes counted by the dl Worker. Anything above 3x the average stored GB that month is billed at 1¢/GB.
- The free $1 comes off each month. Without a card, writes stop at $1 of usage (the account's cap is $1 until a card is added).
- The monthly invoice and usage page show "You saved $X": the ceiling for the peak stored size (max($12, $8 × peak TB), TB measured to the GB; $10/TB on the B2 fallback), minus the actual bill. Hidden when zero or less. The bill itself is min(metered, ceiling); the ceiling is applied at invoice time, so Dodo gets the capped amount. Note the consequence: because the bill is already capped, the saving is $0 for exactly the accounts the ceiling helps most (a metered bill above the ceiling pays the ceiling), so the line reads as headroom against the plan, not as money saved. The baseline is a pricing call, tracked in issue #39.
- The meter pushes each hour's total to Dodo, keyed by account and hour, so a repeat push is ignored.

## Keys and safety

- A device key is limited to `/u/<id>/`, with capabilities `listFiles, readFiles, writeFiles, deleteFiles` (people can really delete; the file stays hidden 1 day in B2 because the drive uses rclone's default hide-not-delete, then sits in Hetzner's old-versions folder for 30 days).
- An agent key has the same prefix, without `deleteFiles`.
- A branch key is limited to `/u/<id>/.branches/<name>/`, without `deleteFiles`.
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
| Fork a whole drive instantly "without copying a byte" | Branches by server-side copy (fast, but it copies) | **Gap** on huge folders | Step 7: measure a 10 GB branch; if it's slow, copy on first write instead |
| Agents read and write the same files | Same, plus one-command setup for Claude, Codex, Gemini, Cursor and Kiro, sandbox connectors, agent undo and per-agent spending caps | **Beat** | Steps 4, 11; issue 13 |
| Teams: pooled storage, whole-drive sharing, member access | Nothing yet | **Gap** (company tier, "Talk to us") | Issue 20 |
| SSO, audit, private cloud (Enterprise) | Not planned | Gap, fine for now | Later |
| $15 a month for 1 TB, full price even when part-full | 2¢ per GB by the minute; the monthly bill never passes max($12, $8 × peak TB) — $16 at 2 TB, $40 at 5 TB (Space charges $15 + $12 flat per extra TB, even when part-full) | **Beat** | Step 6 |

**Speed test (in step 2's "done when"):** from a Mac over home broadband, open a 5 GB video and a 2 GB Blender file straight off the drive. The first frame or viewport must show within 3 s, scrubbing must not stall, and a 1 GB save must reach storage within 10 s. Run the same files on a Space trial side by side if a free trial exists (no card). Otherwise compare against Space's own words, "open instantly" and "in seconds". Record the times in the issue.

## Build steps

Every step is one issue, built by a queue worker and checked by a different model family, in a new product repo made at go time. Each step is done only when its check passes on real files, with the proof (paths, ids, timestamps) in the issue.

| # | Step | What gets built | Done when |
|---|---|---|---|
| 1 | Storage and keys | First, on iDrive e2's free 1 TB, check three things: keys limited to one folder, save and delete notifications, and average-not-peak monthly billing. If all pass, iDrive is primary and everything below uses its S3 API; if any fails, use B2. Then: B2 bucket with versioning, SSE-B2, 1-day lifecycle rule for hidden versions, event rule to the api Worker. Key minting in the api Worker. | An agent key's delete leaves a hidden version, `drive restore` brings it back, and the agent key can't read another user's folder. |
| 2 | Drive on one Mac | CLI writes the rclone config and a launchd login item; `rclone nfsmount` with the cache flags. | A 5 GB video starts playing before it has downloaded, and a file saved then followed by a reboot comes back intact. |
| 3 | Linux and two machines | systemd user unit for `rclone mount`. | A save on the Mac shows up on the Linux box, and a save on Linux shows up on the Mac. |
| 4 | `drive init` and agents | Device sign-in, agent detection, MCP registration for all five tools, skill notes. | On a clean Mac, one `drive init` and then a fresh Claude Code session lists and edits a file in the drive, and the same works in Codex. |
| 5 | Meter | Event intake with de-duplication, `file_versions`, hourly rollup, dl Worker byte counting, nightly reconciler. | One real account's GB-minutes for a whole day match B2's own storage report within 1%, and its download bytes match Cloudflare's analytics within 1%. |
| 6 | Billing and cap | Dodo meters and checkout, $1 credit after card, cap enforcement with key swap, usage page. | A real account is charged the right amount for a real day, and a capped account goes read-only with no file lost and starts writing again once the cap is raised. |
| 7 | Branches | `branch`, `branches`, `diff`, `approve`, `discard`; server-side copy inside B2. | An agent's branch is approved into the original folder; a second is discarded with the original untouched; an approve where the original changed stops and lists the file. |
| 8 | Backup and old versions | Nightly `rclone sync --backup-dir` to the Storage Box plus the 31-day purge, as one systemd timer; Hetzner restores in `drive restore`. | A file edited on day 1 and again on day 3 can be restored to its day-1 version from Hetzner on day 10 with a matching checksum; a file removed from B2 on purpose is restored from Hetzner; and a day-31 folder is gone. |
| 9 | Pricing page and sign-up | Web pages above, pricing copy from spec.md. | A new person signs up, installs, stores a file and sees the right cost on the usage page, on a phone and a desktop. |
| 11 | Connectors for agent sandboxes (after steps 3 and 4) | Two ways in, so the drive works inside boat.dev, E2B, Daytona, Vercel Sandbox, InstaCloud and similar: (a) a one-line install inside a sandbox that mounts the drive with a sandbox token (`drive init --token`), for sandboxes that allow FUSE; (b) a hosted MCP server on the api Worker, so any agent can use the drive with no mount at all. Then a listing or template on each platform that has one. | The same file is read and written from inside a real boat.dev sandbox (mount) and a real E2B sandbox (mount or hosted MCP), with the change visible on the Mac. |
| 10 | Swift File Provider app (later) | Native Finder drive to replace `rclone nfsmount` on Mac. | It passes steps 2 to 4 unchanged. |

Steps 1 to 4 can run with no billing at all, as a private test for Nish's own files. Steps 5 and 6 have to be finished before anyone else is charged.

## Open questions (not blocking the spec)

- **B2 delete events.** I confirmed the "file created" event names in Backblaze's API docs on 2026-09-29. I did not confirm the names for hidden and deleted files. The nightly reconciler covers this either way; step 5 checks it.
- **B2 key limit.** One key per device, agent and branch could mean thousands of keys. Backblaze's key limit was not checked; check it before step 1.
- **Cloudflare terms for a download proxy.** Serving large files through a Worker has to fit Cloudflare's current terms; check before step 5.
- **Mount while read-only.** It is unverified whether rclone keeps waiting uploads safely when its key is swapped for a read-only one. Step 6 proves it.
- **Missed nights.** If the backup timer misses a night, that night's old versions are lost and the purge skips a folder. The timer's failure must alert (unit failure is already watched on the VPS).
- **Business tier** (SSO, SOC 2, pooled bill): after v1, not specced here.

## Stock tools used, nothing hand-built beyond product logic

rclone (mount, nfsmount, server-side copy, sync), B2 versioning, lifecycle rules, scoped keys and event notifications, Cloudflare Workers, D1 and Cron Triggers, Dodo usage billing and hosted portal, the MCP filesystem server, each agent tool's own `mcp add`, launchd, systemd timers. Hand-written: the CLI, the api and dl Workers, the meter and reconciler logic, and the web pages.
