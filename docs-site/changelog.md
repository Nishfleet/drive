---
title: Changelog
description: One line per thing that shipped, newest first.
---

# Changelog

One line per shipped thing. Newest first, and the date is the day it reached
the live site.

## 2026-09-30

- The pricing page, with the rate, the ceiling and a waitlist sign-up.
- The bill ceiling: the metered cost cut off at a flat {{CEILING_FLOOR}} until
  the drive passes 1.5 TB, then {{CEILING_PER_TB}} a TB. This replaced the
  older per-TB caps.
- The free {{FREE_USD}} comes off the month's total, and downloads over
  {{FREE_DOWNLOAD_MULTIPLE}} times what you store are charged at
  {{DOWNLOAD_RATE}}.
- The spending cap: at your cap the drive goes read-only and nothing is
  deleted. The default cap is {{DEFAULT_CAP}}.
- The first-run page, which shows a new machine going from signed out to
  mounted.
- The usage page, which shows the month's stored size and what it cost, worked
  out from the same numbers as the invoice.
- The api Worker: health, keys and usage routes, with one capability table for
  what each kind of key can do.
- `drive status` and `drive logout`.
- `drive init` connects Claude, Codex, Gemini, Cursor and Kiro, and writes
  each tool's own instruction note.
- These docs: Quickstart, How it works, Agents, Pricing and your bill, Limits,
  Security and this changelog, each also served as Markdown.

## Earlier

Before 2026-09-30 the drive was built in steps, not shipped. See
`docs/build-spec.md` in the repository for the plan and the proof of each step.
