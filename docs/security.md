# Supply-chain trust boundaries

This page is for people who work on this repository. The customer page is
`docs-site/security.md`. It lists what code from outside this repository runs
with write access here, and how each download that CI executes is pinned
(drive#581).

## Who can write here

- **fleet-ops writers are drive writers.** `.github/workflows/agent-dispatch.yml`
  calls `Nishfleet/fleet-ops/.github/workflows/agent-dispatch.yml@main` on
  issue, comment, pull-request-target, CI-finished and hourly events. Whatever
  fleet-ops `main` holds at that moment runs on the self-hosted runners with
  `issues: write`, `pull-requests: write` and `contents: write` on this
  repository. So anyone who can merge to fleet-ops `main` can act on this
  repository with those powers.
- **Why the call is not pinned by SHA.** Runner group 3 admits only fleet-ops
  workflows at `@main`. A SHA pin here drifts from `agent.yml@main` and strands
  every dispatched job (Nishfleet/0509#5231). `test/workflow-secrets.test.mjs`
  records the same decision.
- **Why `contents: write` stays.** A called workflow cannot hold more than its
  caller grants, and two fleet-ops jobs need it: `hold-risky` dequeues a risky
  PR from the merge queue, and the close job deletes a closed PR's branch
  (`gh pr close --delete-branch`, fleet-ops#8457). Neither job checks out code,
  so the write token never meets PR head code. If fleet-ops drops both, drop
  `contents: write` from the stub too.
- **What limits the risk.** Both repositories are private, both `main`
  branches are protected, and fleet-ops is Nish's own repository.

## Downloads that CI runs

Every release asset a workflow downloads is checked against a SHA-256 digest
written in this repository before it runs. `test/workflow-downloads.test.mjs`
fails on a workflow step that downloads with `curl`, `wget` or
`Invoke-WebRequest` and does not compare each download with a pinned
`*_SHA256` value in that same step.

| Download | Where | Pin |
| --- | --- | --- |
| rclone, Linux zip | `ci.yml` (two jobs) | `PINNED_RCLONE_LINUX_AMD64_SHA256` |
| rclone, Windows zip | `windows-msi.yml` (two jobs) | `RCLONE_WINDOWS_AMD64_SHA256` |
| WinFsp MSI | `windows-msi.yml` (two jobs) | `WINFSP_MSI_SHA256` |
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
