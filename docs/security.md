# Supply-chain trust boundaries

This page is for people who work on this repository. The customer page is
`docs-site/security.md`. It lists what code from outside this repository runs
with write access here, and how each download that CI executes is pinned
(drive#581).

## Who can write here

- **Only drive writers write here.** No workflow calls code from another
  repository; every merge goes through the `main gate` ruleset and its merge queue.
- **What a stranger can read.** Both repositories are public, so every
  workflow, run log and artifact here is readable by anyone. The weekly backup
  seals each dump with `age` before upload for that reason (`d1-export.yml`):
  a database dump is customer data, and only its ciphertext leaves the
  runner.

## Downloads that CI runs

Every release asset a workflow downloads is checked against a SHA-256 digest
written in this repository before it runs. `test/workflow-downloads.test.mjs`
fails on a workflow step that downloads with `curl`, `wget` or
`Invoke-WebRequest` and does not compare it with a pinned `*_SHA256` value in
that same step, and on a step that holds more than one download.

| Download | Where | Pin |
| --- | --- | --- |
| rclone, Linux zip | `ci.yml` (two jobs) | `PINNED_RCLONE_LINUX_AMD64_SHA256` |
| age, Linux amd64 tar.gz | `d1-export.yml` | `AGE_LINUX_AMD64_SHA256` |
| gitleaks | `ci.yml` | container image digest |
| Lighthouse CI | `ci.yml` | container image digest |
| rclone, in the two-mount test | `test/two-mount-sync.test.mjs` | `RCLONE_ZIPS`, and only with `DRIVE_STANDIN_FETCH_RCLONE=1` |

## Dependency advisories

- Production dependencies: `npm audit --omit=dev` reports none.
- Lighthouse CI (`@lhci/cli` 0.15.1, the newest release) is no longer an npm
  dependency. Its chain carried most of the high advisories, so CI runs it in
  its own container, pinned by digest.
- Two high advisories remain, both in development tools:
  - `undici` under miniflare, under the `@cloudflare/vite-plugin` 2.0
    prerelease. It goes when the pin moves to a tagged 2.0.0 (drive#508).
  - `vite` 6.4.2 and older (with `esbuild`), under `vitepress` 1.6.4, the
    newest stable vitepress. npm has no fix, so drive#615
    tracks it until vitepress ships one.
- Dependabot watches the root npm project, Go modules, GitHub Actions, and the
  agent eval's own npm and pip pins under `evals/agents/`.
