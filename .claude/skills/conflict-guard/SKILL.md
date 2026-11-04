---
name: conflict-guard
description: "Model-check the drive CLI's conflict guard (cmd/drive/conflict_guard.go) with TLA+: a save is either uploaded or kept as a conflict copy, never dropped. Use before you merge any change to conflict_guard.go's pass, sight, decide, previousHash or forgetBaselinesReadAfterUpload, or to rclone queue handling the guard reads."
---

# conflict-guard

## The promise

- Property: when two devices save the same file, this device's save ends either uploaded (it is the file in storage) or kept as a `(conflict, <device>)` copy. The guard never drops it.
- Harm if broken: a user's save disappears with no copy and no message. This happened twice: #1057 (baseline re-read after the other device's upload) and #1143 (slow baseline read that returned after this device's upload and the other device's overwrite).
- Tests reach this only by luck, because the bug needs one remote read to return after two uploads. TLC checks every order of the steps below.

## Run it

Needs Java 11 or later and `tla2tools.jar` v1.7.4 (https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4, sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`), the version `/statechart` pins. From this folder:

```sh
java -XX:+UseParallelGC -cp tla2tools.jar tlc2.TLC -config ConflictGuard.cfg -metadir "$(mktemp -d)" ConflictGuard.tla
```

- `ConflictGuard.cfg` is the code as it is now. It must print `Model checking completed. No error has been found.` (51 distinct states, under 2 seconds). It checks `SightedSaveNeverDropped`.
- `Before1143.cfg` is the code before #1143 (no queue re-check after the baseline read). It must print `Invariant SightedSaveNeverDropped is violated` with a 7-state trace.
- `Before1057.cfg` is today's code with the two pre-#1057 pieces put back: the baseline re-learn, and `decide` giving up on a save whose baseline is unknown. It must print the same violation with a 7-state trace: the save is sighted, both uploads land, the baseline read and the queue re-check leave the baseline unknown, and the guard drops the save. That is the drop CI saw before #1057 ("neither save survived"). The slow-read race on the re-learn is the same race `Before1143.cfg` covers.
- `Unwatched.cfg` is the code now, checked against the full `SaveNeverDropped`. It fails today with a 4-state trace: this device's upload lands, the other device's upload overwrites it, and the guard never saw the save, so nothing keeps a copy. This is an open finding (#869), not a model error. When the code fixes it, this config must pass, and then `ConflictGuard.cfg` should check `SaveNeverDropped` too.
- Delete the `ConflictGuard_TTrace_*` files TLC writes here on a violation.
- If a `Before*` config stops failing, the model has lost the power to see the bug. Fix the model, not the config.

Read every result with the pstack `/statechart` skill: it turns a violation into its shortest path in plain words, and a pass into a chart.

## How the model maps to the code

One file, two writers: this device (`mine`) and another device (`theirs`). Storage starts with `old`. Each action is one atomic step in the code.

| Action | Code (`cmd/drive/conflict_guard.go`) |
|---|---|
| `MyUploadLands` | rclone finishes this device's upload; the name leaves `vfs/queue` (https://rclone.org/rc/#vfs-queue) |
| `TheirUploadLands` | the other device's upload lands and overwrites the file |
| `GuardSightsSave` | `pass` reads the queue once (`b.queue`, start of `pass`) and finds a name it has not seen |
| `BaselineRead` / `BaselineUnreadable` | `sight` -> `previousHash`: one `b.remoteHash` read, at any later moment, or a failed read that leaves `previous` empty |
| `QueueRecheck` / `QueueRecheckFails` | `forgetBaselinesReadAfterUpload` (called at the end of the sighting loop in `pass`): a second `b.queue` read clears `previous` for a save no longer queued; a failed read clears every baseline. Constant `RecheckQueue` turns this off |
| `RelearnStart` / `RelearnRead` | the pre-#1057 re-read of an unknown baseline inside the seen-branch of `pass`, using the queue snapshot from the start of the pass. The read can return after the upload lands, so only `RelearnStart` needs the save queued. Constant `RelearnBaseline`; it is FALSE in the current code |
| `GuardKeepsUpload` | `decide`, `case landed == save.hash` |
| `GuardGivesUp` | `decide`, `case landed == "" \|\| landed == save.previous` after `conflictClaimPolls`: the save is dropped with no copy. With `RelearnBaseline` it also fires on an unknown baseline: the pre-#1057 `case save.baselineUnknown` |
| `GuardKeepsConflictCopy` | `decide`, `default` -> `claim` writes the conflict copy |
| `GuardMissesSave` | the upload finished before any pass saw it in the queue (`pass` only sights names in `b.queue`). The outcome is `lost` when storage no longer holds this save |

Invariants: `SightedSaveNeverDropped` says the guard never takes `GuardGivesUp` for a save it saw. `SaveNeverDropped` adds that no save ends `lost`.

## Scope and assumptions

- One file, one save on this device, one write from another device, one guard. Uploads always succeed in the end (rclone retries).
- Timing is abstract: the claim window (`conflictClaimPolls`) and the win window (`conflictWinPolls`) can end at any step. So `GuardKeepsUpload` ends the check when storage holds this save, and a later overwrite is a later edit, out of scope.
- Not modeled: files over `conflictProtectMax` (compared by size and time), the hash of a file that changes while it is hashed, `claim` name collisions, and the `synced` map across passes.
- Open finding: a save whose upload finishes before any pass sees it (one 500 ms tick) is not watched, so a later overwrite by another device leaves no copy (`Unwatched.cfg`). Only this device's guard is modeled. The other device's guard cannot tell that its save replaced this one, so it does not keep a copy either.

## When you change the guard

1. If your diff touches a function in the table, rerun all four configs.
2. If the code's steps change, change the matching action first, then rerun. Each action must stay one atomic step in the code. Never weaken `SaveNeverDropped` to make a run pass.
3. A violation on `ConflictGuard.cfg`: tell the trace as steps in the table's words. If the steps can happen in the code, it is a real bug: report it. If a step cannot happen in the code, the model is wrong: fix the action and say why.
4. The Go test `TestConflictGuardKeepsASaveWhoseBaselineReadOutlastedItsUpload` drives the #1143 order on the real code. Keep it beside this model.

## Sync record

- Covers `pass`, `sight`, `previousHash`, `forgetBaselinesReadAfterUpload` and `decide` in `cmd/drive/conflict_guard.go`.
- Last confirmed against commit `4638e28`. Move this forward only after you confirm the model still describes the code at the new commit. Run `/maintain-formal-verification-skill` when the guard changed without a recheck.
