# SpaceFS clone: spec (vault edition)

Written 2026-09-29. Replaces the published doc "SpaceFS-style Drive: Pressure Test and Spec" (https://claude.ai/code/artifact/9c1807f2-c63e-4a5e-8b4b-501e4bc71781) as the working spec. Built from `../index.md` and `../machine/plan.md`; those two files were not edited. Where this spec and the published doc disagree, see `disagreements.md` next to this file.

## Status

**Building since 2026-09-29** (Nish: "lets go then"). The 2026-09-29 pressure test said no-go and the old rule was no spend before 0509 passes $2k; Nish overrode that. Spending money still needs his yes.

Revisit when both are true:
- 0509 passes $2k revenue.
- A specific paying niche (for example people with >4 TB video archives) shows demand.

## Pressure test (2026-09-29)

These rows were worked out at the earlier 1¢/GB price, before the 2026-09-30 bill ceiling, and are kept as the record. The current price is 2¢/GB billed by the minute, with the monthly bill capped at max($12, $8 × peak TB) (see Pricing).

| Question | Finding |
|---|---|
| Margin | B2 costs $6.95/TB/month. At 1¢/GB we keep about $3/TB before payment fees and support. $2k/month revenue needs about 200 TB stored. |
| What SpaceFS sells | Speed, not price. Premiere, Resolve and Blender open huge files straight off the drive, where Drive, iCloud and Dropbox download the whole file first. A price-led clone misses what its buyers pay for. Space (Space Computer, Inc.) raised $2.4M pre-seed in Aug 2026 led by a16z Speedrun. No public paying-customer numbers. |
| Cost floor | Replicated storage is $4 to $7/TB wholesale (Storj and IDrive e2 about $4, Hetzner Object €5.99, B2 $6.95). Only Hetzner Storage Box reaches about €2/TB, and it is one datacenter with SFTP/WebDAV and 10 connections. Realistic undercut is about $6/TB against SpaceFS's $12 per extra TB. |
| Pay-per-GB wedge | A 200 GB user pays $2 with us versus SpaceFS's $15 floor; our margin is about $0.60/month. But 200 GB fits on a laptop, and iCloud/Google sell 200 GB for $2.99. At multi-TB sizes 1¢/GB saves only 20 to 35% (3 TB: $30 vs $39). |
| Charging more | 1.5¢/GB gives about $8/TB margin on B2 (54%) and matches SpaceFS at 1 TB ($15). Fixes margin, not demand. |
| Charge by active use | Kept files cost the full B2 rate all month, and there is no server to switch off. B2 bills per byte-hour with no minimum retention, so cost only tracks use when files are deleted after use (a 1 TB workspace alive 20 h/month costs about $0.19). That fits agent scratch space, but scratch space is better on the sandbox's own free, 4 to 185x faster disk. |
| People | Google One, iCloud+ and Dropbox sell 2 TB for about $10/month and already stream on demand. 1¢/GB costs twice their rate and only matters above 2 TB. LucidLink owns video teams. |
| Agents | AWS S3 Files (GA 2026-04-07), Archil ($11M Series A, $0.20/GiB active cache), JuiceFS (free), Turso AgentFS, Vercel Sandbox Drives ($0.05/GB-month beta, 2026-09-23), Docker Cloud Sandboxes (free volumes, 2026-09-24), Mastra, Mesa. No moat for a B2 reseller. |
| Own benchmarks | FUSE over object storage was 4 to 185x slower than local for agent work; cold 1 GB read about 39 s (about 220 Mbps). Raw logs no longer exist. |

## Jev verdicts

| When (UTC) | Context | Result |
|---|---|---|
| 2026-09-29 04:28 (jev-1.13.0) | First opinion | proceed 0.16, agents-only 0.26, people-first 0.18 |
| 2026-09-29 04:48 (jev-1.13.0) | Full context plus 4 Exa searches, 9,933 input tokens | people-first 1.0, agents-only 0, both 0 |

The first says don't build. The second says if you build, sell to people first. A thin-context call at 04:46 gave 0.74 for people-first and is not counted. Evidence behind the second: Space saw surprise demand from solo creators and YouTubers, shipped an Individual tier in Aug 2026 and targets 10k paying users; agent storage is being bundled free or cheap into sandbox platforms.

## What to build if greenlit

**A drive for people and their agents: a Finder folder that streams plain files from Backblaze B2, set up with one command that also connects Claude Code, Codex, Cursor, Gemini and Kiro. Billed only for what is stored, 2¢/GB/month billed by the minute, and the monthly bill never passes max($12, $8 × peak TB) — never more than $12 a TB, then $8.**

- **Who it's for:** people first (solo creators with libraries bigger than their laptop disk). Agents are a free extra, not the product.
- **Why it could win:** no plan floor, pay only for the GB-hours you use, and the bill never passes max($12, $8 × peak TB). Honest limit: it costs more than iCloud/Google for files kept all month.
- **What it is not:** not a video-team product (LucidLink), not a Windows product, not an app-hosting cloud (InstaCloud), not open source or self-hostable.
- **No owned servers.** Storage on B2, with a backup copy on a Hetzner Storage Box. The drive runs on the user's Mac.

### Pricing

**Recommendation (updated 2026-09-30, Nish): 2¢ per GB-month, billed by the minute (changed from per second on 2026-09-29, Nish; never advertise a per-minute price), with downloads included up to 3x what you store. The monthly bill is min(metered, max($12, $8 × peak TB)), TB measured to the GB; on the B2 fallback the ceiling rate is $10/TB (so max($12, $10 × peak TB)) — the page's "$8" holds only while iDrive is primary.** 1.5¢ is the hard floor for the metered rate (Nish); the ceiling deliberately prices below it ($12 for 1 TB is 1.2¢/GB, $8 a TB above 1.5 TB is 0.8¢/GB). Keep 1.5¢ in reserve for a yearly prepaid plan, the way Space discounts yearly billing by 25%. The full test is below.

| Item | Choice |
|---|---|
| Price | 2¢/GB-month, billed by the minute, shown as a monthly total |
| Bill ceiling | min(metered, max($12, $8 × peak TB)), TB measured to the GB; B2 fallback $10/TB (Nish, 2026-09-30) |
| Minimum per file | 1 hour of storage (B2 bills us by the byte-hour; proposed 2026-09-29, not yet confirmed by Nish) |
| Downloads | Free up to 3x your average stored data each month, then 1¢/GB (the same rule B2 applies to us) |
| Billing | Dodo usage billing on what is stored; no fixed monthly minimum |
| Free credit | $1 of storage free every month (about 50 GB), no card needed to start; a card only to go past it. Shown in dollars, never as credit units or expiring balances (Nish, 2026-09-29, from the Higgsfield research) |
| Headline | "Never more than $12 a TB, then $8" as the ceiling line under the rate; never an "unlimited" plan (Nish, 2026-09-30) |
| Spending cap | Each account sets one, default $20; storage goes read-only on exceeding the cap, nothing is deleted. Email at 80%. The cap counts min(metered so far, ceiling) (Nish via #464, 2026-10-04) |
| "You saved" line | Copy varies by month type (Nish via #39, 2026-09-30): capped month (metered > ceiling) "Our price cap saved you $X", X = metered − bill; uncapped month "You paid $X less than a flat plan", X = ceiling − bill. Hidden when X ≤ 0, or when the month's bill is $0 |
| Business tier (on the pricing page from day one as "Talk to us", built later) | Same storage price. Sells single sign-on, SOC 2 report, a pooled company bill with per-team breakdown, and support. No fixed monthly minimum |
| Snapshots | Paid add-on only |
| Storage | iDrive e2 as primary — one bucket per customer, each key limited to that bucket (drive#371) — plus a backup copy on a Hetzner Storage Box. Backblaze B2 stays the standby |

#### Pricing pressure test (1.5¢ to 2¢, prices checked 2026-09-29)

**Our costs per TB kept all month**

| Provider | Storage | Downloads | Minimum stay and other catches | Fit |
|---|---|---|---|---|
| Backblaze B2 | $6.95 | Free up to 3x stored, then $10/TB | None. API calls free (a rare class costs $0.004 per 10k after 2,500/day) | **Standby**: iDrive keeps step 1 on drive#371's bucket answer, so B2 is what the build falls back to if the reseller API stops answering |
| Hetzner Storage Box (BX41, 20 TB) | about €2 (€40.60 for the box) | Free | Fixed box sizes, one datacenter, SFTP/WebDAV only, 10 connections | **Backup copy** |
| Hetzner Object Storage | €5.99 base covers 1 TB + 1 TB downloads, then billed per TB-hour | Includes 1 TB | 64 KB minimum billed object size. Overage rate not readable on the page | Live second copy if a premium tier needs one |
| iDrive e2 | $4.96 on yearly plans ($59.50/TB/year); **$5/TB-month billed monthly on the Veeam/MSP/Reseller plan, $5 minimum (1 TB), first 1 TB free to try** (Nish's screenshot, 2026-09-29) | Free up to 3x stored, then $10/TB | Has event notifications, versioning and no API fees (site checked 2026-09-29). Measured on the real account 2026-10-03 (drive#173): keys limited to one folder — **No**, the endpoint's STS has no `AssumeRole` and its access keys scope to buckets, never to a prefix, so the `u/<account-id>/` scope has nothing to bind to. A month is billed on neither average nor peak: one storage figure per 30-day cycle, and an object deleted early stays billed to day 30, so the 1-day hidden-version rule caps retention, not cost. Still unchecked: whether we qualify as a reseller | **Primary** (measured 2026-10-03, drive#173: no `AssumeRole`, keys scope to buckets; answered by drive#371, 2026-10-04: one bucket per customer, so the scope is the bucket). Margin at 2¢ with the Storage Box: about 54%, against 44% on B2. Still unchecked: whether we qualify as a reseller, and the mint and revoke on the real account, which need the reseller token |
| Wasabi | $7.99 | Free within its fair-use policy | 90-day minimum stay and a 1 TB minimum charge | Rejected: breaks hourly billing |
| Storj | $7 | $7/TB | 30-day minimum stay, $5 minimum monthly fee | Rejected: download fee and minimum stay |
| Cloudflare R2 | $15 | Free | None. $4.50 per million writes, $0.36 per million reads | Rejected as primary: costs as much as our whole 1.5¢ price |

Payment fees (Dodo): 4% + 40¢, plus 1.5% for cards outside the US. A $10 top-up loses about 9.5%, a $25 top-up about 7%, and a $50 top-up about 6%. The margins below use 9.5%, the worst case.

**Margin per TB kept all month, after Dodo fees**

| Setup | Cost/TB | 1.5¢ ($15) | 1.75¢ ($17.50) | 2¢ ($20) |
|---|---|---|---|---|
| B2 only (no fallback) | $6.95 | $6.63 (44%) | $8.89 (51%) | $11.15 (56%) |
| **B2 + Storage Box backup** | about $9.25 | $4.33 (29%) | $6.59 (38%) | **$8.85 (44%)** |
| B2 + Hetzner Object live copy | about $13.45 | $0.13 (1%) | $2.39 (14%) | $4.65 (23%) |
| R2 only | $15 | -$1.43 | $0.84 (5%) | $3.10 (16%) |

A fallback copy is what makes the price matter. At 1.5¢ with a backup copy, 29% has to cover support, refunds ($1 each) and disputes ($30 each). One dispute wipes out about seven TB-months of margin.

**Fallback plan:** the Mac app writes each file to B2 and the Storage Box. If B2 has an outage, files already on the Mac keep working and uncached files wait. If B2 loses data or closes the account, restore from the Storage Box. Accounts at Hetzner Object Storage and iDrive e2 stay open but empty, so new writes can be pointed there within a day. An empty standby costs $0.

**Against Space** (checked on spacefs.com 2026-09-29: Individual $15/month billed yearly ($180), "save 25%", so about $20 month to month (inferred). Extra storage $6 per 500 GB. Teams $30/member yearly)

Where we stop being cheaper, for data kept all month:

| Our price | vs Space yearly ($15) | vs Space monthly (about $20) |
|---|---|---|
| 1.5¢ | Below 1 TB | Below 2.67 TB |
| 1.75¢ | Below 857 GB | Below 1.45 TB |
| 2¢ | Below 750 GB | Below 1 TB |

**Part-full drives (Nish's point, 2026-09-29).** Space charges the full plan whether you fill it or not. We charge only for the GB actually stored each hour, so the bill tracks the month's average fill. Daily ups and downs average out.

| Average fill of 1 TB | Us at 2¢ | Us at 1.5¢ | Space yearly | Space monthly |
|---|---|---|---|---|
| 20% (200 GB) | $4.00 | $3.00 | $15 | about $20 |
| 40% (400 GB) | $8.00 | $6.00 | $15 | about $20 |
| 60% (600 GB) | $12.00 | $9.00 | $15 | about $20 |
| 100% (1 TB) | $20.00 | $15.00 | $15 | about $20 |

So at 2¢, a Space customer who averages 60% full or less pays less with us, by 20% to 73%. Two caveats:
- **We bill what's stored, not what's opened.** Someone with 1 TB of files who opens 50 GB a day still pays for 1 TB. The saving only goes to people who hold less data than their plan, not to light readers.
- **No real fill data.** A web search on 2026-09-29 found no public study of how full paid cloud-drive plans are. The 20/40/60% rows are scenarios, not measurements.

**Other rivals at 2¢**
- iCloud+, Google One, Dropbox: 2 TB for about $10 (about $5/TB). They beat us on any library kept all month at every price in range. We only win on no plan sizes, hourly billing and agent access.
- Vercel Sandbox Drives: $0.05/GB-month ($50/TB). We're 60% cheaper.
- Archil: $0.30/GB-month on the free Developer plan after 10 GB, $0.20 on Team (screenshot from Nish, 2026-09-29). That's 10 to 15 times our 2¢; they sell speed, we sell cheap.
- InstaCloud (InsForge, Inc., checked 2026-09-29 at https://www.instacloud.com/pricing): an app-hosting cloud for developers, not a Finder drive. It bills per second: object storage about $15.20/TB-month, disk volumes about $152/TB-month, downloads $0.05/GB ($50/TB). Plans: Free ($10 credit/month), Pro ($20/month minimum), Team ($499/month). Its storage is 24% cheaper than ours if you never read it, but one full read of 1 TB costs $50 there against free (up to 3x) with us. Per-second billing is normal for developer clouds, so hourly billing alone is no edge with developers; streaming plain files into Finder for people still is. No change to price or verdict.

**Second research pass (2026-09-29, evening)**
- boat.dev (by ASCII, checked at https://docs.boat.dev/pricing.md , /snapshots.md , /billing.md): per-second agent sandbox VMs, not a drive. `default` is 4 vCPU / 8 GB / 50 GB disk at $0.036/hour; largest disk is 251 GB. $20/month plan minimum, all of it returned as machine time; 25 free trial hours. Stopped sandboxes cost nothing, and their snapshots are kept free for the sandbox's life. So a few hundred GB of agent files can sit there free, but you must start a VM (or `boat snapshot pull`) to read them, and snapshots stay private to the creator. It competes with us only for small agent scratch space. It is a better fit as a place our drive gets mounted than as a rival. No change to price or verdict.
- Space: raised a $2.4M pre-seed on 2026-08-18 (a16z Speedrun), about 100 users or teams in private beta (https://thenextweb.com/news/space-ai-native-filesystem-a16z-speedrun-2-4m). Price unchanged at $15/month for 1 TB; Teams $30 per member. Windows still "coming soon". Changelog to 2026-09-22 is upload, Linux and billing polish, including "spending controls" (https://spacefs.com/changelog/). Space is now funded, so a copycat race on features is harder; price and per-hour billing stay our only clear edges.
- TiDB Cloud Filesystem (PingCAP, https://www.pingcap.com/tidb-cloud-filesystem-pricing-details/): agent workspace storage, $0.30/GB-month fast or $0.025/GB-month pooled, prorated hourly, downloads $0.09/GB, $5 monthly credit. Its cheapest tier is 25% dearer than our 2¢.
- TiDB note: Nish's screenshots (2026-09-29) of TiDB Cloud Starter ($0.20/GiB over 25 GiB free), Essential (about $20/day) and Dedicated (from $1,376/month) are its database plans, not the Filesystem product above. The database storage price is 10 times ours.
- Archil (https://archil.com/pricing): now also lists an Archive tier at $0.025/GB-month, still above 2¢. Raised an $11M Series A on 2026-04-20.
- Also seen, prices not found: Tigris/TigrisFS, Fast.io, Neon "agentfs" (unverified).
- No new Finder-style consumer drive rival found in the last 60 days.
- Demand for per-second storage billing: still no direct evidence. The closest signals are hourly billing at TiDB and Vercel. X, Reddit and HN were not searched this pass.

**Third research pass (2026-10-01: Cloudflare's two storage launches)**

Both posts read 2026-10-01, with the docs and pricing pages behind them. Same four columns and the same Beat / Match / Gap vocabulary as "Against Space, feature by feature" in `docs/build-spec.md`; the Verdict cell carries one verdict per recorded fact, in the order the facts are given, and says "no price verdict is possible" rather than inventing one where Cloudflare publishes no price. Neither of these is a Finder-style consumer drive, so the second pass's "no new Finder-style consumer drive rival found in the last 60 days" still stands. Neither changes the price: the only stored-byte price either of them publishes is Artifacts' $0.50/GB-month, 25x ours.

| Rival offers | Us | Verdict | Where |
|---|---|---|---|
| **Cloudflare Artifacts** (open beta, Workers Paid plan only). **Stores:** Git repositories for code and agent context, not a person's file library — **1 GB max per repository, 32 MB max per file**, 1 TB per account (raisable on request), unlimited repos and namespaces (https://developers.cloudflare.com/artifacts/platform/limits/). **Versions:** every repo has its own full Git history and refs, a fork starts from an existing repo's history and then diverges independently, access is repo-scoped (each repo has its own tokens, each limited to read or write), and repos stay stored until you delete them — so every version is kept forever, not for 30 days (https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/). **Price:** **$0.50 per GB-month** after the first 1 GB, plus $0.15 per 1,000 operations over 10,000 a month; a GB-mo is the average peak per day over a 30-day period, and replicas add nothing (https://developers.cloudflare.com/artifacts/platform/pricing/). **Finder: no documented desktop client.** The docs name exactly three interfaces — Workers binding, REST API, standard Git client — and nine Artifacts doc pages read 2026-10-01 carry no Finder, desktop, mount, FUSE or rclone mention. That is what the research found; it is not a claim that no client can exist. | Any file a person has, in a mounted folder on macOS and Linux that streams on demand; 1 TB per account, no per-file cap; versions kept 1 day, then one a day for 30 days, and branches are server-side copies; 2¢ per GB-month by the minute, bill never above max($12, $8 × peak TB); stock rclone, and $1 free with no card. | **Beat** on price (2¢ against $0.50/GB-month, 25x, and operations are metered on top); **Beat** on opening a person's own files (no documented desktop client, and a 32 MB file cap rules out the 5 GB video the spec opens with); **Match** on how much one account may hold, their 1 TB per account raisable on request against our 1 TB with unlimited repos on their side, so capacity is an edge in neither direction; **Match** on an agent working in a repo through scoped tokens, their repo-scoped read/write tokens against our scoped keys plus a fork to work in. **Gap** on retained versions: they keep every commit until the repo is deleted, we keep 30 days (same Gap the Space table already carries). **Gap** on fork lineage: their fork starts from existing history, ours copies the bytes — though their 1 GB repo cap puts the huge-folder case out of their range entirely. | https://blog.cloudflare.com/next-git-platform-on-cloudflare/ (open beta, Workers Paid, billing, events), https://developers.cloudflare.com/artifacts/platform/pricing/, /artifacts/platform/limits/, /artifacts/concepts/how-artifacts-works/ — all read 2026-10-01. Step 8 and issue 133 track the retention; issue 133 is the open claim the pricing page and llms.txt make about it. |
| **Cloudflare Container filesystem snapshots** (public beta, `durable_object` scheduling policy only; the `default` policy can neither take nor restore one). **Stores:** a saved point-in-time image of one running container's whole filesystem — repository, dependencies, build caches, config, edits — not memory or running processes, and the handle is a plain data object you store yourself. **Versions:** snapshots are **immutable**, so a changed workspace is a brand-new snapshot with nothing linking it to the last one; each is **tied to the container image version it was made from** and is not portable to a different image; **max 20 GB per snapshot, kept 30 days** from creation or the most recent restore, and a restore refreshes that 30 days (https://developers.cloudflare.com/containers/guides/snapshots/, /containers/platform/limits/). **Price: none published for stored snapshot bytes.** The nearest billed number is a *running* container's provisioned disk at $0.00000007 per GB-second with 200 GB-hours a month included (https://developers.cloudflare.com/containers/platform/pricing/), which works out at about $0.18 per GB-month over 730 hours for a live container's disk and is **not** a price for stored snapshot bytes — and reading anything costs CPU ($0.000020 per vCPU-second) and memory ($0.0000025 per GiB-second) on top. **Finder: no documented desktop client** — a person has to start a container from the snapshot to see a single byte, and pay it to run. | Files stay stored until the person deletes them, with no TTL; versions kept 1 day, then one a day for 30 days; 2¢ per GB-month by the minute against about $0.18, and nothing to pay to open a file; a mounted folder, stock rclone. | **Beat** on retention: a saved workspace on our drive does not expire, a snapshot is gone 30 days after the last restore. **Beat** on opening a person's files: no documented desktop client, and reading one byte means starting a container and paying it to run. **Gap** that we have no save-and-restore of a whole agent workspace between sessions, only files and branches — that is what a snapshot is for, and their pattern is the better one. **No price verdict is possible**, and that is the honest cell: Cloudflare publishes no per-GB price for stored snapshot bytes, so it cannot be called dearer or cheaper than 2¢. The published figures around it are compute, not storage, so a "Beat on price" here would be a comparison of two different things. | https://blog.cloudflare.com/faster-agent-sandboxes/ (snapshots in public beta, immutability, the eval pattern), https://developers.cloudflare.com/containers/guides/snapshots/, /containers/platform/limits/, /containers/platform/pricing/ — all read 2026-10-01. Step 11 (sandbox connectors) is where a snapshot is a place our drive gets mounted, the same read as boat.dev. |

Two things this pass settles. **Billing starts 2026-10-14, not 2026-10-15** as the blog post says: both the Artifacts pricing page and the open-beta changelog post give October 14 (https://developers.cloudflare.com/changelog/post/2026-10-01-artifacts-open-beta/), and the blog post (https://blog.cloudflare.com/next-git-platform-on-cloudflare/) gives October 15. Either way it has not started, so no rival bill exists to measure yet. And **neither is a price threat on the numbers that exist**: Artifacts is 25x our rate at $0.50/GB-month, the only stored-byte price either of them publishes, while snapshots publish no per-GB price at all, so that one is unpriced rather than beaten and the figures around it are compute. Both are built for code and agent context rather than for a person's file library, which is the thing the rest of this spec is priced against.

**Who wins and loses at each price**

| Customer | 1.5¢ | 1.75¢ | 2¢ |
|---|---|---|---|
| Under 750 GB kept all month (vs Space) | Wins | Wins | Wins |
| Space customer whose 1 TB plan is under 60% full | Wins | Wins | Wins |
| 0.75 to 2.7 TB kept all month | Wins vs monthly, ties yearly at 1 TB | Wins below 1.45 TB monthly | Loses above 1 TB |
| Over 3 TB video archives (the revisit niche) | Loses (Space adds TB at $12) | Loses | Loses |
| Short agent jobs (a day or a week) | Wins on price | Wins | Wins |
| Heavy streamers reading more than 3x stored | We lose money unless over-3x downloads are billed | Same | Same |
| Anyone happy with iCloud/Google under 2 TB | Loses | Loses | Loses |

**Risks**
- **Short jobs vs the download allowance.** B2's free 3x is based on average stored data, and it's pooled across our whole account. A 1 TB job that lives one day counts as only 33 GB stored, so reading it once could use about $9 of download allowance on a $0.66 bill. Pooling with all-month customers covers this at small scale; billing downloads over 3x is the backstop.
- **The >4 TB niche (changed by the 2026-09-30 ceiling).** The rows above were priced before the ceiling, when Space's $12/TB add-on beat us there; under the new bill (5 TB = $40 against Space's $63) the niche is won on price, so the vault's revisit trigger now waits on demand only. The who-wins table above is not re-run; it stands as the 2026-09-29 record.
- **Fees on small top-ups.** $10 top-ups lose about 9.5%. Encourage $25 or more.
- **Exchange rate.** Hetzner bills in euros. The €2/TB Storage Box figure assumes about $1.15 per euro.

**Jev (2026-09-29 05:36 UTC, jev-1.13.0):** 2¢ at 0.52, 1.75¢ at 0.31, 1.5¢ at 0.17. Not decisive (below 0.9), so this recommendation is my call, and it matches Jev's lean. Why 2¢: every customer group we can win at 1.5¢ is also won at 2¢, except the 1 to 2.7 TB band. 2¢ keeps a 44% margin with a real backup copy. 1.5¢ keeps only 29%.

Price sources (checked 2026-09-29): https://www.backblaze.com/cloud-storage/pricing , https://www.backblaze.com/cloud-storage/transaction-pricing , https://developers.cloudflare.com/r2/pricing/ , https://wasabi.com/pricing/faq , https://www.hetzner.com/storage/object-storage/ , https://docs.hetzner.com/storage/object-storage/overview/ , https://www.hetzner.com/storage/storage-box/bx41/ , https://www.idrive.com/s3-storage-e2/pricing , https://www.storj.io/pricing , https://dodopayments.com/pricing , https://spacefs.com

### How it works

- Files are stored as plain files in one bucket per user, one folder per account inside it. No chunking, no custom format, so anything that speaks S3 or rclone can read them.
- Opening a file streams it; only what you open uses disk space.
- A file uploads a few seconds after it is closed (decision 2026-09-28). No 60-second whole-drive snapshots.
- Agents use the same files through the drive folder, an MCP server or the S3 API, each with its own scoped key.

### Version 1 features

| Feature | What you see |
|---|---|
| One-command setup | `drive init` signs you in, mounts the drive and connects every agent tool it finds |
| Drive in Finder | A folder that works in any app, on Mac and Linux |
| Files on demand | Big files open without downloading first |
| Save, then sync | Changes upload a few seconds after you close the file and appear on your other machines |
| Version history | Free. Every earlier version kept 1 day, then one per day for 30 days; restore any file |
| Agent access | Agents read and write freely; they cannot permanently delete |
| Branches | `drive branch <folder>` makes an instant copy for an agent to work in; you approve or throw it away |
| Usage bill | Per-minute billing, $1 free credit a month, spending cap |

Left out of version 1: Windows, sharing links, search, phone app, Business tier, self-hosting.

### Nothing missing

The remaining product gaps are now specced, one issue each (the version-1 exclusions above are separate and stay out):

| Issue | What it closes |
|---|---|
| [#30](https://github.com/Nishfleet/drive/issues/30) | Two machines, one file: keep both saves, and work offline |
| [#31](https://github.com/Nishfleet/drive/issues/31) | Web Files page: open your drive from any browser or phone (a web page, not a native phone app) |
| [#32](https://github.com/Nishfleet/drive/issues/32) | First run and sync status: always know it's working |
| [#33](https://github.com/Nishfleet/drive/issues/33) | Emails: welcome, cap warnings, payment failed, monthly receipt |
| [#34](https://github.com/Nishfleet/drive/issues/34) | Account lifecycle: export, delete, sign out everywhere, update, uninstall |
| [#35](https://github.com/Nishfleet/drive/issues/35) | Every error says what happened and what to do |

## Build plan

Full build spec (parts, commands, screens, data model, steps): `build-spec.md` next to this file.

Status: **building since 2026-09-29** (Nish: "lets go then"). Work is queued as issues #2 to #15; anything that costs money waits for Nish.

### Parts, and the stock tool behind each

We write only the product's own logic (sign-up, key minting, metering, billing glue, CLI). Everything else is a shipped feature of an existing tool.

| Part | Stock tool | What we write |
|---|---|---|
| Storage | Backblaze B2, one bucket, a folder per user | Nothing |
| Version history, safe deletes | B2 bucket versioning with a 1-day lifecycle rule, then 30 days of old versions on the Storage Box via rclone's `--backup-dir` (Nish, 2026-09-29; see build-spec.md) | Nothing |
| Per-user and per-agent access | B2 application keys limited to one folder; agent keys get no `deleteFiles` capability, so an agent's delete only hides a file and a person can undo it | Key minting in the sign-up service |
| Mac drive (v1) | `rclone nfsmount` (uses macOS's built-in NFS, so no kernel extension or macFUSE), with the VFS cache and write-back a few seconds after close | Config written by the CLI |
| Linux drive | `rclone mount` with the same cache settings | Config written by the CLI |
| Free downloads | rclone's `--b2-download-url` pointed at a Cloudflare-proxied hostname; B2 to Cloudflare traffic is free under Backblaze's partner program | A Worker on that hostname that counts bytes per user |
| Agent tools | Each tool's own MCP registration (`claude mcp add`, `codex mcp add`, Cursor's `mcp.json`, Gemini and Kiro config), the stock MCP filesystem server pointed at the mounted drive, and a short skill file per tool | The CLI steps that call those commands |
| Metering | B2 Event Notifications on file create and hide, sent to a Cloudflare Worker, stored in Cloudflare D1 | Worker that turns events into GB-seconds per user, with a 1-hour minimum per file; one exception (drive #104, decided 2026-10-03): a version that stopped at the instant a same-size version took its place books no second minimum, because those bytes never left the drive |
| Billing | Dodo usage-based billing meters (Dodo charges $1 per million events) | Send each user's usage to Dodo hourly, apply the $1 credit and the cap |
| Branches | rclone server-side copy inside B2 (no download) | `drive branch`, `drive approve`, `drive discard` |
| Backup copy | `rclone sync` from B2 to a Hetzner Storage Box, nightly | One scheduled job; name the runner at go time |
| Sign-up service | Cloudflare Worker (serverless, so still no owned servers) | Account creation, device login, key minting |

### Build order (each step has a real-file finish line)

1. **Storage and keys.** Bucket, versioning, 1-day lifecycle, a folder-scoped user key and a no-delete agent key. Done when the agent key's delete is undone by restoring the hidden version.
2. **Drive on one Mac.** `rclone nfsmount` with write-back. Done when a 5 GB video opens without a full download and a saved file survives a restart intact.
3. **Two machines.** A Mac and a Linux box on the same folder. Done when a save on one shows up on the other.
4. **One-command setup.** `drive init` on a clean Mac mounts the drive and registers the MCP server with Claude Code and Codex. Done when Claude Code, in a fresh session, lists and edits a file in the drive.
5. **Metering.** Event Notifications into D1, plus download counting on the Worker. Done when one user's GB-seconds for a day match B2's own storage report within 1%.
6. **Billing.** Dodo meters, $1 credit, spending cap. Done when a real account is charged correctly for a real day and a capped account goes read-only without losing files.
7. **Branches and approvals.** Done when an agent's branch is approved into the main folder, and a second branch is discarded with the main folder untouched.
8. **Backup.** Nightly sync to the Storage Box. Done when a file deleted in B2 is restored from the Storage Box.
9. **Swift File Provider app (later).** Replaces `rclone nfsmount` on Mac for a native Finder look. Done when it passes steps 2 to 4 unchanged.

Who builds it: queue workers, one issue per step, in a new product repo created at go time. Each step's reviewer is a different model family from its builder.

### Risks

| Risk | How bad | What we do |
|---|---|---|
| A bug loses someone's file | Fatal | Versioning on from step 1, agents can't hard-delete, nightly copy to a second company, restore tested in steps 1 and 8 |
| Metering drifts from B2's real bill | High | Step 5 reconciles against B2's own report before anyone is charged |
| Pricier than Space above 750 GB kept all month | High | Aim at part-full plans, small libraries and agent jobs; keep 1.5¢ for a yearly plan |
| Free credit gets abused with throwaway accounts | Medium | Without a card an account stops at $1 of usage (about 50 GB, about 35¢ a month to us); the free $1 covers storage only, not downloads above 3x |
| Per-minute billing at tiny scale charges less than B2 bills us | Low | 1-hour minimum per file matches B2's byte-hour billing |
| NFS mount quirks on macOS | Medium | Proven in step 2; the Swift app replaces it later |
| Two saves clash | Medium | The last save wins, and the earlier one stays in version history; the Swift app should keep both side by side |

### The meter database at scale (decided 2026-10-05, drive #564)

The one shared D1 database stays. `file_versions` is the fast grower — every upload, overwrite and delete is a row — so the nightly meter trip now deletes rows hidden more than 35 days (the 30-day restore window plus the provider's own 30-day version keep, plus 5 days of margin) once every hourly rollup has booked their minutes into `usage_minutes`, and writes one size row a day (`nightly_sizes`, also printed to the Worker log) so growth is watched, not discovered.

Two alternatives were rejected:

- **Per-account D1 databases.** The rollup groups every account's versions in one GROUP BY, the caps and month usage read across accounts, and the rollup watermark is one row. D1 has no cross-database query, so a split turns each hourly run into N queries plus a directory of which account lives where — a standing cost on every hour, bought against a size limit measured nightly instead.
- **A per-account manifest object in the account's bucket.** The meter's answers are SQL aggregates (per-hour grouping, MIN/MAX, the same-size waiver's NOT EXISTS). A manifest object cannot answer those without loading every account's full manifest every hour, which is the DISTINCT scan this decision removes, moved to slower storage.

**Trigger to revisit:** act when the nightly size row shows `file_version_rows` above 20 million (about 5 GB of rows and indexes, half of D1's 10 GB per-database cap) for a week, or the Cloudflare dashboard shows the drive database above 5 GB, whichever comes first. Below that line the nightly prune and the accounts-table lists keep every scan proportional to live data, not to history.

## Rules

- Do not queue build work until Nish says go. Reuse this spec and `../machine/plan.md` instead of re-researching.
- For the fleet's own agent storage, use stock JuiceFS or rclone; never build.
- Related: [[zero-revenue-no-spend]], [[product-strategy-0509-only]].

## Sources (checked 2026-09-29)

1. SpaceFS: https://spacefs.com
2. Space founder update: https://newsletter-byjasonz.beehiiv.com/p/things-are-moving-fast-here-at-space
3. Forbes on Space: https://www.forbes.com/sites/davidprosser/2026/08/18/space-paves-the-way-for-the-infinite-computer/
4. Space $2.4M pre-seed: https://www.thesaasnews.com/news/space-raises-2-4m-pre-seed/
5. Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
6. Hetzner Storage Box BX41: https://www.hetzner.com/storage/storage-box/bx41/
7. Hetzner Object Storage: https://www.hetzner.com/storage/object-storage/
8. Object storage comparison 2026: https://mixpeek.com/blog/object-storage-comparison-2026
9. AWS S3 Files: https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-s3-files
10. Archil pricing: https://archil.com/pricing
11. Vercel Sandbox Drives: https://vercel.com/changelog/drives-for-vercel-sandbox-are-now-in-public-beta
12. Docker Cloud Sandboxes: https://www.docker.com/blog/introducing-cloud-sandboxes-start-on-your-laptop-finish-in-the-cloud/
13. Mastra managed filesystems: https://mastra.ai/blog/introducing-managed-sandboxes-and-filesystems-for-mastra-platform
14. Mesa: https://www.mesa.dev/blog/introducing-mesa-filesystem-for-agents
15. LucidLink pricing: https://www.g2.com/products/lucidlink/pricing
16. ExpanDrive pricing: https://www.expandrive.com/pricing
17. Mountain Duck: https://mountainduck.io/
