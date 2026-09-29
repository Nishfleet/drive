# node-repo-template

Template for new Node/JS repos. Already wired to the canonical reusable CI in
[nish3451/shared-workflows](https://github.com/nish3451/shared-workflows) — the
CI standard applies by construction, with no per-repo setup.

## Use it

1. Click **"Use this template"** on
   [nish3451/node-repo-template](https://github.com/nish3451/node-repo-template)
   → "Create a new repository".
2. Clone your new repo.
3. Edit `package.json` (`name`, add your `scripts`).
4. The first PR runs the standard CI automatically:
   - changed-files gate (docs-only PRs skip install/test/build, still scan secrets)
   - `npm ci` (cached)
   - `npm test` (or whatever you set as `verify-command`)
   - gitleaks secret scan
   - timeout-minutes, concurrency + cancel-in-progress, 7-day SARIF retention

## Customize CI without leaving this repo

Edit `.github/workflows/pr-checks.yml` inputs only — never copy the workflow
body. Available inputs:

| input | default | purpose |
|---|---|---|
| `node-version` | `24` | Node version. |
| `install-command` | `npm ci` | Install command. Empty string skips install + npm cache (no lockfile). |
| `verify-command` | `npm test` | Test/build command. Empty string skips. |
| `python-version` | `""` | Python version. Empty skips Python setup. |

Example — a repo that builds:

```yaml
    with:
      node-version: "22"
      install-command: npm ci
      verify-command: npm test && npm run build
```

## What you inherit automatically

Every improvement to `nish3451/shared-workflows` on the `v1` branch reaches this
repo's CI with no action from you. That is the whole point: the standard is
defined once and enforced everywhere, current and future.
