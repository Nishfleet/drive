# Agent notes for drive

A Finder drive for people and their agents: plain files in object storage, mounted with stock rclone, billed at 2¢ per GB-month by the minute.

- The spec is `docs/build-spec.md` (what to build, step by step) and `docs/spec.md` (why: prices, rivals). The vault copy under `02 Projects/spacefs-clone/spec/` is the source; update both together.
- Every build step's finish line is proven on real files and real accounts, cited by path, id or timestamp. A green test alone is not done.
- Stock tools only (rclone, the storage provider's versioning, lifecycle rules and scoped keys, Cloudflare Workers, D1 and Cron Triggers, Dodo, the MCP filesystem server). Hand-write only the product's own logic: the `drive` CLI, the api and dl Workers, the meter, and the web pages.
- No money is spent without Nish. Free tiers and free trials only; if a signup asks for a card, stop and mark the issue `agent-blocked` with that reason.
- Secrets live in the VPS credential store, never in this repo.
- The Mac is read-only for agents. Mac-only proofs (step 2) run on a GitHub macOS runner or are marked for Nish.
