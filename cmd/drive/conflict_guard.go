package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The conflict guard (drive issue #30). It runs inside the mount
// process for as long as the mount does, like the background fill:
// one goroutine, stock rclone's own remote control, no second
// daemon and no script.
//
// Every pass is bounded work, then the decision on what was taken:
//
//   1. vfs/queue names this device's own uploads that storage has
//      not taken yet. A path there is a save in flight. The pass
//      takes up to conflictSightMax saves it has not seen before
//      and hashes each one straight out of the VFS cache file the
//      bytes live in, then keeps a hold snapshot of those bytes so
//      a later claim can copy them after rclone drops the cache as
//      stale. It also reads what the plain path held before from
//      one listing of the save's folder. A drop bigger than the
//      bound is taken pass after pass, where the last pass stopped.
//   2. A path that leaves the queue has landed. The pass polls up
//      to conflictPollMax landed paths, oldest first, and again
//      resumes where it stopped. For each, the object's hash at the
//      plain path is compared with this device's own hash. Equal
//      means this device's save is the one that landed, but the
//      save is not decided yet: the other device's own write-back
//      timer may not have fired, so the plain path stays watched
//      for conflictWinPolls polls before the win is declared.
//   3. A hash that is neither this device's bytes nor the version
//      that was there before means the other device's save landed.
//      The plain path holds the other device's bytes, so the bytes
//      are read once more through this device's own mount — the
//      hash taken at first sight proved they are still the ones
//      this device saved — and written to storage as the conflict
//      copy under the losing device's own name, verified by reading
//      the written object back.
//
// The rule never deletes, never renames and never guesses: a hash
// that is neither this device's bytes nor the version that was
// there before is the only thing that writes a conflict copy, and
// the bytes written are verified against this device's own hash.
// A save the rule cannot protect — gone, not a regular file, over
// the size cap, or bytes the mount no longer serves — is named as
// a skip, because a named skip is a thing a person can read and act
// on and a silent one is a lost save nobody heard about.

// conflictInterval is the guard's period. The write-back window is
// 5s, so half a second is well inside it and the guard is still one
// system call per half second on a machine that is doing nothing
// else.
const conflictInterval = 500 * time.Millisecond

// conflictContextTimeout bounds one pass, so a wedged remote-control
// call cannot hold the guard forever.
const conflictContextTimeout = 30 * time.Second

// conflictSightMax is the most saves one pass hashes for the first
// time. A pass that had to sight every path in the queue would grow
// with the drop — a 100k-file drop cannot stage and hash in one pass
// — so the pass takes the first conflictSightMax unseen saves in
// queue order and the rest are taken by the passes that follow, from
// where this one stopped. The gap between what is queued and what is
// sighted is the backlog `drive status` names.
const conflictSightMax = 100

// conflictPollMax is the most landed paths one pass decides on. Like
// conflictSightMax it keeps one pass's work fixed no matter how large
// the drop, and the cursor makes the next pass continue down the
// watch list rather than always polling the same first hundred.
const conflictPollMax = 100

// conflictProtectMax bytes is the largest save the guard protects.
// The bytes are hashed straight out of the VFS cache, so nothing is
// copied, but a file this size is still read whole to hash it and
// read again to claim it. A larger file is left alone rather than
// half-protected, and the skip is reported: a named skip is a thing
// a person can read and act on, a silent one is a lost save nobody
// heard about.
const conflictProtectMax = 64 << 20

// conflictClaimPolls is how long a path whose upload has left the queue
// is watched while the plain path still holds the version that preceded
// the save (the upload has not landed, or it landed on a path that had no
// object). Such a path is not a decided conflict, and staying on it
// forever would grow the map on a mount that never stops.
const conflictClaimPolls = 20

// conflictWinPolls is how long the guard keeps watching after this
// device's own save has landed at the plain path, before concluding the
// save was not overwritten. Another device's upload can land on top of
// this one for the whole of one sync window after it: a save made two
// seconds later still has its five-second write-back to land on top of an
// upload that landed a moment ago. A same-instant PUT can also miss that
// window entirely: rclone refuses it as "corrupted on transfer: sizes
// differ" and retries 10s later, and a win declared before that retry
// leaves the earlier save with no copy (TestTwoDevicesKeepBothSaves).
// The plain path is polled every conflictInterval, so 40 polls are 20s:
// the 5s write-back, the 10s retry, and margin for rclone's scheduling.
const conflictWinPolls = 40

// conflictHashFailPolls is how many remote-hash failures one path may
// take after it leaves the queue before the skip is named. Holding
// forever with no line would hide a save that never decides.
const conflictHashFailPolls = 10

// conflictReportEvery is the least time between two reports of the
// same cause, so a persistent failure keeps a named heartbeat on the
// mount's log rather than one line and then silence.
const conflictReportEvery = time.Minute

// conflictCopyLimit caps the numbered conflict copies for one path,
// so a repeated conflict with the same device name cannot grow
// without end.
const conflictCopyLimit = 99

// conflictStateFresh is how long after updatedAt the guard's state
// file still counts as the guard's own answer. The guard writes it
// every pass (every conflictInterval), so this many seconds of
// silence is a guard that stopped.
const conflictStateFresh = 5 * time.Second

// pendingSave is one save in flight: this device's own hash, the
// object hash that preceded the save, and the stat the hash was taken
// at. A save this device cannot protect is recorded here too, with
// the reason named, so the skip is said once instead of on every
// pass.
type pendingSave struct {
	// hash is the md5 of this device's bytes, taken through the
	// mount while the upload was still queued.
	hash string
	// previous is the object hash at the plain path when the save
	// was first seen in the queue. It is what the upload is allowed
	// to replace. It is sampled at first sight, so a guard whose
	// first glance is late enough that another device's save has
	// already landed reads that save as the baseline; the write-back
	// window is 5s and the pass period is 500ms, so first sight is
	// normally inside it.
	previous string
	// stat is the stat of the file as this device's mount served it
	// when hash was taken. The bytes the upload will carry are the
	// bytes on this device's mount at upload time, so before a
	// decision the guard re-hashes a file whose stat has changed,
	// lest the decision be made against an older version than the
	// one that landed.
	stat mountFileInfo
	// reason names a save the rule left alone, and is empty for a
	// save the rule protects.
	reason string
	// reported is set once the skip has been named, so one skip is
	// one line rather than one line per pass for the life of the
	// upload.
	reported bool
	// polls is how many polls this path has been watched since its
	// upload left the queue without landing, while the plain path still
	// holds the version that preceded the save.
	polls int
	// winPolls is non-zero once this device's own save has landed at the
	// plain path. While it is ticking, the guard keeps watching for an
	// overwrite by another device rather than declaring the save the winner
	// the instant it sees its own bytes: an upload can land on top of an
	// own upload seconds later and still be within one sync window.
	winPolls int
	// byFingerprint is a save too large to hash whole: it is compared
	// by size and mtime, not by a local md5, so a new remote is this
	// device's landing rather than a skip that would alarm on every
	// ordinary large upload.
	byFingerprint bool
	// hashFails is how many remote-hash errors this path has seen
	// since its upload left the queue.
	hashFails int
	// baselineUnknown is set when the remote hash could not be read at
	// first sight, so previous is not the version the save replaces. It
	// is read again on later passes while the save is queued. Until it is
	// known, a version that is not this device's is not claimed as a
	// conflict, and a save that leaves the queue still unknown is named.
	baselineUnknown bool
	// holdPath is a snapshot of this device's bytes, taken when the
	// save was hashed. rclone can remove the VFS cache file as stale
	// once another device's PUT has landed, so the claim copies from
	// this snapshot rather than from a mount that no longer holds
	// the save.
	holdPath string
}

// conflictBackend is what one guard pass needs from a running mount.
// rclone's remote control is the implementation; the interface is so
// the decision itself can be tested against a counted stand-in rather
// than only on a real two-mount host.
type conflictBackend interface {
	// queue names the uploads this device has not yet landed.
	queue(ctx context.Context) ([]queueEntry, error)
	// remoteHas reports whether an object exists at the plain path.
	remoteHas(ctx context.Context, name string) (bool, error)
	// remoteHash is the object's md5 at the plain path, "" when
	// there is no object there. A missing object is an answer, not
	// an error: a save that lands where nothing was is exactly the
	// case the rule has to name.
	remoteHash(ctx context.Context, name string) (string, error)
	// remoteVersion is the size and modification time of the object at
	// the plain path, and ok is false when there is no object there. A
	// save too large to hash whole has no local md5 to set against the
	// remote ETag, so its version is what tells this device's landing
	// from another device's.
	remoteVersion(ctx context.Context, name string) (size int64, modTime time.Time, ok bool, err error)
	// parentContents names the files one folder of the remote holds,
	// so a path the listing leaves out is a path that never existed
	// and no hash needs reading for it. A folder that does not exist
	// yet holds no paths, which is an answer and not an error: the
	// first save into a new folder queues before rclone has created
	// the folder in storage.
	parentContents(ctx context.Context, dir string) (map[string]bool, error)
	// copyLocalToRemote uploads one file this device can read into
	// the mount's own remote, under dstRemote, with rclone's own
	// copy operation.
	copyLocalToRemote(ctx context.Context, srcRoot, srcRemote, dstRemote string) error
	// refresh asks rclone to refresh the mount's directory cache,
	// so the conflict copy is visible through the mount rather
	// than only in storage. recursive is the fill's own choice and
	// is never true here: a conflict copy is always in the folder
	// whose save was lost, so only that folder's listing changed.
	refresh(ctx context.Context, recursive bool) error
	// forget drops one path from rclone's VFS cache. operations/hashsum
	// and operations/stat on the mount's remote control can still name
	// this device's cache after another device's PUT has landed; forgetting
	// the path makes the next read hit storage.
	forget(ctx context.Context, name string) error
}

// ConflictResult is what one guard pass did, so a proof and a log
// line can read what happened without re-running it.
type ConflictResult struct {
	// Watched is the number of saves in flight the pass saw.
	Watched int
	// Behind is how many saves in flight no pass has taken in yet:
	// the drop is bigger than one pass, and the passes that follow
	// will take the rest. It is what `drive status` reports.
	Behind int
	// Claimed is the remote path of a conflict copy this pass
	// wrote, with the device that wrote it and the path it
	// protects.
	Claimed []ConflictCopy
	// Skipped is a save the rule left alone, with the reason.
	// Named, so it is visible and a person can act on it.
	Skipped []ConflictSkip
}

// ConflictSkip is one save the rule did not protect, and the reason:
// the save was not in the drive any more, it was not a regular file,
// or it was larger than the protection cap.
type ConflictSkip struct {
	Remote string
	Reason string
}

// ConflictCopy is one conflict copy: the name the losing save is
// kept under and the device that lost it.
type ConflictCopy struct {
	Remote     string
	LosingPath string
	Device     string
}

// conflictGuard holds the saves this mount is watching. One per
// mount. order is the watch list in first-sight order and cursor is
// where the next pass starts polling, so a pass that can only decide
// conflictPollMax paths decides the oldest first and the next pass
// continues from there instead of always polling the same first
// hundred: that is how a drop bigger than one pass is finished, pass
// after pass.
type conflictGuard struct {
	device   string
	mountDir string
	cacheDir string
	fs       string
	seen     map[string]*pendingSave
	order    []string
	cursor   int
	synced   map[string]string // last-synced fingerprint per path
}

// newConflictGuard builds the guard for one mount. The identity of
// this device's save is its hash, taken straight out of the VFS cache
// file the bytes live in. A hold snapshot of those bytes is kept until
// the save is decided, because rclone can drop the cache file as stale
// once another device's PUT has landed.
func newConflictGuard(device, mountDir string) *conflictGuard {
	return &conflictGuard{
		device:   device,
		mountDir: mountDir,
		seen:     map[string]*pendingSave{},
		synced:   map[string]string{},
	}
}

// pass is one iteration of the rule. It is the whole decision, so
// the tests drive it directly.
func (g *conflictGuard) pass(ctx context.Context, b conflictBackend) (ConflictResult, error) {
	var res ConflictResult
	queue, err := b.queue(ctx)
	if err != nil {
		return res, fmt.Errorf("conflict: read the upload queue: %w", err)
	}
	inFlight := make(map[string]bool, len(queue))
	for _, e := range queue {
		if e.Name == "" {
			continue
		}
		inFlight[e.Name] = true
	}
	res.Watched = len(inFlight)

	// Step 1: first sights, bounded. Take the first conflictSightMax
	// unseen saves in queue order and leave the rest for later
	// passes; every unseen save left behind is one save of backlog
	// that `drive status` names. A save that cannot be hashed is
	// named and left alone rather than failing the pass: one save
	// that is gone, or is not a regular file, must not stop the
	// other saves in the same queue from being protected.
	listings := map[string]map[string]bool{}
	hashes := 0
	for _, e := range queue {
		if e.Name == "" || !inFlight[e.Name] {
			continue
		}
		if save, ok := g.seen[e.Name]; ok {
			if save.baselineUnknown {
				if previous, unknown, err := g.previousHash(ctx, b, e.Name, listings); err == nil {
					save.previous, save.baselineUnknown = previous, unknown
				}
			}
			if save.reason == "" && g.mountChanged(e.Name, save) {
				if save.byFingerprint {
					info, err := g.mountStat(e.Name)
					if err != nil {
						save.reason = fmt.Sprintf("the save is not in the drive any more: %v", err)
					} else if reason := statReason(info); reason != "" && info.size <= conflictProtectMax {
						save.reason = reason
					} else if info.size > conflictProtectMax {
						save.stat = info
						save.hash = fmt.Sprintf("size:%d:mtime:%d", info.size, info.modTime.UnixNano())
					} else {
						save.byFingerprint = false
						reason, err := g.rehash(e.Name, save)
						if err != nil {
							return res, err
						}
						if reason != "" {
							save.reason = reason
						}
					}
				} else {
					reason, err := g.rehash(e.Name, save)
					if err != nil {
						return res, err
					}
					if reason != "" {
						save.reason = reason
					}
				}
			}
			if save.reason != "" && !save.reported {
				res.Skipped = append(res.Skipped, ConflictSkip{Remote: e.Name, Reason: save.reason})
				save.reported = true
			}
			continue
		}
		if hashes >= conflictSightMax {
			res.Behind++
			continue
		}
		hashes++
		save, skip, err := g.sight(ctx, b, e.Name, listings)
		if errors.Is(err, errNoCacheFile) {
			// The VFS cache file is not there yet (or was evicted).
			// Leave the save unseen so the next pass can hash it;
			// failing this pass would skip every other save too.
			hashes--
			continue
		}
		if err != nil {
			return res, err
		}
		g.seen[e.Name] = save
		// Reason entries join the walk order too: they are retired by
		// steps 2 and 3 once the queue releases them, and a retire
		// costs no poll budget.
		g.order = append(g.order, e.Name)
		if skip.Reason != "" {
			res.Skipped = append(res.Skipped, skip)
		}
	}

	// Steps 2 and 3: poll landed paths, oldest first, bounded, and
	// resume from where the last pass stopped. Paths finish (dropped,
	// claimed, or named as unprotectable) into finished, and the
	// watch list is shortened after the walk: an entry removed while
	// the cursor is mid-walk would shift the slice under it.
	finished := make([]string, 0, 4)
	polled := 0
	i := g.cursor
	if i >= len(g.order) {
		i = 0
	}
	for n := 0; n < len(g.order); n++ {
		if polled >= conflictPollMax {
			break
		}
		name := g.order[i]
		save, ok := g.seen[name]
		if ok && !inFlight[name] {
			if save.reason != "" {
				// The queue has released a save that was named as
				// unprotectable: its line is on the mount's log and
				// the upload is over, so the entry goes with the
				// queue. It is not decided again, and dropping it
				// costs no poll budget.
				finished = append(finished, name)
			} else {
				polled++
				drop, skip, copy, err := g.decide(ctx, b, name, save)
				if err != nil {
					return res, err
				}
				if copy != nil {
					res.Claimed = append(res.Claimed, *copy)
				}
				if skip != nil {
					res.Skipped = append(res.Skipped, *skip)
				}
				if drop {
					finished = append(finished, name)
				}
			}
		}
		i++
		if i == len(g.order) {
			i = 0
		}
	}
	next := 0
	if len(g.order) > 0 {
		next = i
	}
	g.order, g.cursor = retireFinished(g.order, finished, next)
	for _, name := range finished {
		if s := g.seen[name]; s != nil {
			s.dropHold()
		}
		delete(g.seen, name)
	}
	if len(res.Claimed) > 0 {
		// The conflict copies are objects in storage now. rclone's
		// directory cache is what a listing of the mount reads, so
		// both devices need it refreshed to see them; this one does
		// it for its own listing. The other device sees the copy on
		// its next listing, which is the same 5s --dir-cache-time
		// step 3 measures for any save: no save is pushed to the
		// other machine, and this is no different.
		if err := b.refresh(ctx, false); err != nil {
			return res, fmt.Errorf("conflict: refresh after claiming: %w", err)
		}
	}
	return res, nil
}

// retireFinished takes finished names out of the watch list and returns
// the list that remains plus the cursor of the name the walk was about
// to visit next. Removals shift the slice, so the cursor is found by
// name: a path that finished is skipped, and a path that did not keeps
// its place so the next pass resumes there instead of jumping.
func retireFinished(order, finished []string, next int) ([]string, int) {
	if len(finished) == 0 {
		if next > len(order) {
			return order, 0
		}
		return order, next
	}
	drop := make(map[string]bool, len(finished))
	for _, name := range finished {
		drop[name] = true
	}
	want := ""
	if len(order) > 0 {
		if next >= len(order) {
			next = 0
		}
		want = order[next]
	}
	kept := make([]string, 0, len(order))
	for _, name := range order {
		if !drop[name] {
			kept = append(kept, name)
		}
	}
	if want == "" || len(kept) == 0 {
		return kept, 0
	}
	if !drop[want] {
		for i, name := range kept {
			if name == want {
				return kept, i
			}
		}
		return kept, 0
	}
	for k := 0; k < len(order); k++ {
		name := order[(next+k)%len(order)]
		if drop[name] {
			continue
		}
		for i, keptName := range kept {
			if keptName == name {
				return kept, i
			}
		}
	}
	return kept, 0
}

// sight takes one save the guard has never seen: hash the bytes the
// mount serves now, and read what the plain path held before. A
// non-empty skip reason in the reply is a save the rule leaves
// alone, named; only a real failure (a read that fails, a remote
// control call that fails) is an error.
func (g *conflictGuard) sight(ctx context.Context, b conflictBackend, name string, listings map[string]map[string]bool) (*pendingSave, ConflictSkip, error) {
	info, err := g.mountStat(name)
	if err != nil {
		// The save was removed between the queue listing and the
		// read: the operator took it out of the drive, so there is
		// nothing to protect and nothing has failed.
		skip := fmt.Sprintf("the save is not in the drive any more: %v", err)
		return &pendingSave{reason: skip, reported: true}, ConflictSkip{Remote: name, Reason: skip}, nil
	}
	if !info.regular {
		reason := fmt.Sprintf("it is a %s, not a regular file", info.modeType)
		return &pendingSave{reason: reason, reported: true}, ConflictSkip{Remote: name, Reason: reason}, nil
	}
	if info.size > conflictProtectMax {
		// Large files are compared by size and mtime rather than hashed
		// whole: a 64 MiB cap would skip them and a late overwrite would
		// go unnoticed.
		fp := fmt.Sprintf("size:%d:mtime:%d", info.size, info.modTime.UnixNano())
		save := &pendingSave{hash: fp, stat: info, byFingerprint: true}
		previous, unknown, err := g.previousHash(ctx, b, name, listings)
		if err != nil {
			return nil, ConflictSkip{}, err
		}
		save.previous, save.baselineUnknown = previous, unknown
		return save, ConflictSkip{}, nil
	}
	hash, err := g.hashMountFile(name)
	if errors.Is(err, errProtectTooLarge) {
		// The save grew past the cap between the size check and the
		// hash, so the bytes are not the whole save: a hash of a
		// truncated read would claim a version nobody saved.
		skip := fmt.Sprintf("the save grew past the %d-byte protection cap while it was hashed", conflictProtectMax)
		return &pendingSave{reason: skip, reported: true}, ConflictSkip{Remote: name, Reason: skip}, nil
	}
	if err != nil {
		return nil, ConflictSkip{}, fmt.Errorf("conflict: read %s from the mount: %w", name, err)
	}
	save := &pendingSave{hash: hash, stat: info}
	previous, unknown, err := g.previousHash(ctx, b, name, listings)
	if err != nil {
		return nil, ConflictSkip{}, err
	}
	save.previous, save.baselineUnknown = previous, unknown
	save.holdPath = g.snapshotSave(name, hash)
	return save, ConflictSkip{}, nil
}

// decide is steps 2 and 3 for one landed path: re-hash if this device
// wrote the file again, read what landed, and either watch, win, or
// claim. drop says the path is finished and leaves the watch list;
// skip names a save the rule found it could not protect.
func (g *conflictGuard) decide(ctx context.Context, b conflictBackend, name string, save *pendingSave) (drop bool, skip *ConflictSkip, copy *ConflictCopy, err error) {
	save.polls++
	landed, err := b.remoteHash(ctx, name)
	if err != nil {
		return g.hashFailed(name, save, "the remote hash for this file could not be read")
	}
	switch {
	case save.byFingerprint && landed != "" && landed != save.previous:
		// A fingerprint-watched save has no local md5 that could
		// equal the remote ETag, so the object's size and mtime say
		// whose version it is: rclone carries the file's mtime to
		// storage, so this device's landing matches what it hashed
		// and another device's save does not.
		size, modTime, ok, err := b.remoteVersion(ctx, name)
		if err != nil {
			return g.hashFailed(name, save, "the size and time of this file in storage could not be read")
		}
		if !ok {
			return false, nil, nil, nil
		}
		if sameVersion(size, modTime, save.stat.size, save.stat.modTime) {
			save.winPolls++
			if save.winPolls >= conflictWinPolls {
				g.synced[name] = landed
				return true, nil, nil, nil
			}
			return false, nil, nil, nil
		}
		g.synced[name] = landed
		return true, &ConflictSkip{
			Remote: name,
			Reason: "another version landed on a file too large to keep a copy of",
		}, nil, nil
	case landed == save.hash:
		// This device's save is the one that landed. An overwrite can
		// still land on top of it for the whole sync window after it,
		// because the other device's own write-back timer has not fired
		// yet, or because rclone refused that PUT as a size mismatch and
		// will retry it in 10s, so the guard does not declare a win the
		// moment it sees its own bytes: it watches for conflictWinPolls
		// polls and only then drops the entry.
		//
		// operations/hashsum on the mount's remote control can still
		// name this device's VFS cache after the other PUT has landed,
		// so the object's size is the check that cannot be fooled by
		// that cache: a different length is the retried overwrite.
		if size, _, ok, vErr := b.remoteVersion(ctx, name); vErr == nil && ok && size > 0 && save.stat.size > 0 && size != save.stat.size {
			return g.keepLosingSave(ctx, b, name, save, landed)
		}
		// When hashsum and stat both still name the VFS cache, forget
		// the path so the next read is storage (TestTwoDevicesKeepBothSaves).
		if ferr := b.forget(ctx, name); ferr == nil {
			if h, herr := b.remoteHash(ctx, name); herr == nil && h != "" && h != save.hash && h != save.previous {
				return g.keepLosingSave(ctx, b, name, save, h)
			}
			if size, _, ok, vErr := b.remoteVersion(ctx, name); vErr == nil && ok && size > 0 && save.stat.size > 0 && size != save.stat.size {
				return g.keepLosingSave(ctx, b, name, save, landed)
			}
		}
		save.winPolls++
		if save.winPolls >= conflictWinPolls {
			g.synced[name] = landed
			return true, nil, nil, nil
		}
		return false, nil, nil, nil
	case landed == "" || landed == save.previous:
		// Nothing has landed where this save was going, or the
		// object is the version that preceded the save: not a
		// decided conflict. The queue released the path on an
		// error, or the upload is still on its way, so it is
		// watched a little longer.
		if save.polls >= conflictClaimPolls {
			return true, nil, nil, nil
		}
		return false, nil, nil, nil
	case save.baselineUnknown:
		// The version that preceded the save was never read, so a
		// version that is not this device's may be that one and is
		// not claimed as a conflict. It is watched a little longer,
		// then named: an overwrite in that window cannot be told
		// from the version the save replaced.
		if save.polls >= conflictClaimPolls {
			return true, &ConflictSkip{
				Remote: name,
				Reason: "the version before this save could not be read, so an overwrite could not be told apart",
			}, nil, nil
		}
		return false, nil, nil, nil
	default:
		return g.keepLosingSave(ctx, b, name, save, landed)
	}
}

// keepLosingSave writes this device's bytes under the conflict name, because
// the plain path now holds another device's save.
func (g *conflictGuard) keepLosingSave(ctx context.Context, b conflictBackend, name string, save *pendingSave, landed string) (bool, *ConflictSkip, *ConflictCopy, error) {
	if save.byFingerprint {
		g.synced[name] = landed
		return true, &ConflictSkip{
			Remote: name,
			Reason: "the file is compared by size and time and a copy could not be kept",
		}, nil, nil
	}
	info, statErr := g.mountStat(name)
	if errors.Is(statErr, os.ErrNotExist) {
		skip := fmt.Sprintf("the save is no longer on this machine, so its bytes cannot be kept: %v", statErr)
		return true, &ConflictSkip{Remote: name, Reason: skip}, nil, nil
	}
	if statErr == nil && info.size > conflictProtectMax {
		skip := fmt.Sprintf("%d bytes is over the %d-byte protection cap", info.size, conflictProtectMax)
		return true, &ConflictSkip{Remote: name, Reason: skip}, nil, nil
	}
	if save.holdPath != "" {
		if _, err := os.Stat(save.holdPath); err != nil {
			save.dropHold()
		}
	}
	if save.holdPath == "" {
		mountHash, err := g.hashMountFile(name)
		if errors.Is(err, errProtectTooLarge) {
			skip := fmt.Sprintf("the save grew past the %d-byte protection cap while it was claimed", conflictProtectMax)
			return true, &ConflictSkip{Remote: name, Reason: skip}, nil, nil
		}
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || errors.Is(err, errNoCacheFile) {
				skip := fmt.Sprintf("the save is no longer on this machine, so its bytes cannot be kept: %v", err)
				return true, &ConflictSkip{Remote: name, Reason: skip}, nil, nil
			}
			return false, nil, nil, fmt.Errorf("conflict: read %s from the mount: %w", name, err)
		}
		if mountHash != save.hash {
			return true, &ConflictSkip{Remote: name, Reason: conflictSkipSourceChanged}, nil, nil
		}
	}
	claim, err := g.claim(ctx, b, name, save)
	if errors.Is(err, errClaimSourceChanged) {
		return true, &ConflictSkip{Remote: name, Reason: conflictSkipSourceChanged}, nil, nil
	}
	if err != nil {
		return false, nil, nil, err
	}
	g.synced[name] = landed
	return true, nil, &claim, nil
}

// hashFailed counts one failed read of a landed save's remote version and,
// after conflictHashFailPolls of them, names the save and drops it in the
// same pass, so a path whose remote cannot be read is not watched for ever.
func (g *conflictGuard) hashFailed(name string, save *pendingSave, reason string) (bool, *ConflictSkip, *ConflictCopy, error) {
	save.hashFails++
	if save.hashFails >= conflictHashFailPolls && !save.reported {
		save.reason = reason
		save.reported = true
		return true, &ConflictSkip{Remote: name, Reason: reason}, nil, nil
	}
	return false, nil, nil, nil
}

// rehash replaces a save's hash with the hash of the bytes the mount
// serves now, after this device wrote the file again. A non-empty
// reason is a save the rule can no longer protect (gone, not a
// regular file, over the cap), named so the caller can report it
// once; only a read that fails is an error.
func (g *conflictGuard) rehash(name string, save *pendingSave) (string, error) {
	info, err := g.mountStat(name)
	if err != nil {
		return fmt.Sprintf("the save is not in the drive any more: %v", err), nil
	}
	if reason := statReason(info); reason != "" {
		return reason, nil
	}
	hash, err := g.hashMountFile(name)
	if errors.Is(err, errProtectTooLarge) {
		return fmt.Sprintf("the save grew past the %d-byte protection cap while it was hashed", conflictProtectMax), nil
	}
	if err != nil {
		return "", fmt.Errorf("conflict: read %s from the mount: %w", name, err)
	}
	save.stat, save.hash = info, hash
	save.dropHold()
	save.holdPath = g.snapshotSave(name, hash)
	return "", nil
}

// claim writes this device's bytes under the conflict name and stops
// watching the path. The name is looked up, the copy is read back,
// and a name that holds some other writer's bytes is retried under
// the next number: two mounts answering to the same device name can
// look at the same free name in the same instant, so a conflict copy
// is only this device's save once the object says so. The source is
// this device's own mount: the hash taken when the save was sighted,
// and re-taken when the file changed, proved the mount still serves
// the bytes this device saved. The caller drops the path from the
// watch list.
func (g *conflictGuard) claim(ctx context.Context, b conflictBackend, path string, save *pendingSave) (ConflictCopy, error) {
	for index := 1; ; index++ {
		name, err := freeConflictName(ctx, b, path, g.device, index)
		if err != nil {
			return ConflictCopy{}, fmt.Errorf("conflict: %w", err)
		}
		src := save.holdPath
		if src == "" {
			src = g.sourceFile(path)
		}
		if src == "" {
			return ConflictCopy{}, errClaimSourceChanged
		}
		if err := b.copyLocalToRemote(ctx, filepath.Dir(src), filepath.Base(src), name); err != nil {
			return ConflictCopy{}, fmt.Errorf("conflict: copy %s to %s: %w", path, name, err)
		}
		kept, err := b.remoteHash(ctx, name)
		if err != nil {
			return ConflictCopy{}, fmt.Errorf("conflict: read %s back: %w", name, err)
		}
		if kept == save.hash {
			return ConflictCopy{Remote: name, LosingPath: path, Device: g.device}, nil
		}
		if srcHash, srcErr := hashPath(src); srcErr != nil || srcHash != save.hash {
			return ConflictCopy{}, errClaimSourceChanged
		}
		if index >= conflictCopyLimit {
			return ConflictCopy{}, fmt.Errorf("conflict: every conflict name for %s holds another writer's bytes", path)
		}
	}
}

// mountStat is the stat of a path as this device's mount serves it.
func (g *conflictGuard) mountStat(name string) (mountFileInfo, error) {
	info, err := os.Stat(filepath.Join(g.mountDir, filepath.FromSlash(name)))
	if err != nil {
		return mountFileInfo{}, err
	}
	return mountFileInfo{modTime: info.ModTime(), size: info.Size(), regular: info.Mode().IsRegular(), modeType: info.Mode().Type()}, nil
}

// mountFileInfo is the part of a file's stat the guard compares
// between passes: when the mtime or the size changes, this device has
// written the file again.
type mountFileInfo struct {
	modTime  time.Time
	size     int64
	regular  bool
	modeType os.FileMode
}

// statReason names a path the guard leaves alone, from its stat
// alone: not a regular file, or over the protection cap.
func statReason(info mountFileInfo) string {
	if !info.regular {
		// A directory or a symlink is not a save whose bytes can
		// be hashed.
		return fmt.Sprintf("it is a %s, not a regular file", info.modeType)
	}
	if info.size > conflictProtectMax {
		return fmt.Sprintf("%d bytes is over the %d-byte protection cap", info.size, conflictProtectMax)
	}
	return ""
}

// mountChanged reports whether this device's mount now serves different
// bytes at the path than the ones hashed. rclone's VFS updates the mtime
// when the file is written, so the mtime and the size are rclone's own
// signal that the write-back upload will carry newer bytes than the
// hash holds. A stat that fails reads as "unchanged", so a stat that
// fails never triggers a re-hash on its own.
func (g *conflictGuard) mountChanged(name string, save *pendingSave) bool {
	info, err := g.mountStat(name)
	if err != nil || info.modTime.IsZero() || save.stat.modTime.IsZero() {
		return false
	}
	return !info.modTime.Equal(save.stat.modTime) || info.size != save.stat.size
}

// previousHash is the object hash at the plain path before this save
// lands: the baseline the decision compares against. One listing of
// the save's folder answers "was there ever an object here" for every
// sibling at once, so a drop of new files into one folder costs one
// listing instead of one hashsum per file, and a path the listing
// leaves out is known to have never existed: nothing to read, and
// nothing to wait for when the decision runs.
func (g *conflictGuard) previousHash(ctx context.Context, b conflictBackend, name string, listings map[string]map[string]bool) (string, bool, error) {
	if previous := g.synced[name]; previous != "" {
		return previous, false, nil
	}
	present, err := g.parentListing(ctx, b, parentDir(name), listings)
	if err != nil {
		// A prefix that is not in storage yet (the first save into a new
		// drive) makes rclone's listing fail. That is not a failed pass:
		// fall back to one hashsum, which answers "no object" the same
		// way it did before the listing existed.
		hash, herr := b.remoteHash(ctx, name)
		if herr != nil {
			return "", true, nil
		}
		return hash, false, nil
	}
	if !present[remoteBase(name)] {
		return "", false, nil
	}
	hash, err := b.remoteHash(ctx, name)
	if err != nil {
		return "", true, nil
	}
	return hash, false, nil
}

// parentListing is the set of file names one folder of the remote
// holds, listed once per pass per folder: listings is the pass's own
// cache, thrown away with the pass, because a listing is a moment in
// time and the queue is the truth about what is in flight.
func (g *conflictGuard) parentListing(ctx context.Context, b conflictBackend, dir string, listings map[string]map[string]bool) (map[string]bool, error) {
	if set, ok := listings[dir]; ok {
		return set, nil
	}
	set, err := b.parentContents(ctx, dir)
	if err != nil {
		return nil, fmt.Errorf("conflict: list %s: %w", dirLabel(dir), err)
	}
	listings[dir] = set
	return set, nil
}

// parentDir is the folder part of a '/'-separated remote path, ""
// for a path at the top of the drive.
func parentDir(name string) string {
	if i := strings.LastIndex(name, "/"); i >= 0 {
		return name[:i]
	}
	return ""
}

// dirLabel is a folder named for a person reading a log: the empty
// folder is the top of the drive, not an empty string.
func dirLabel(dir string) string {
	if dir == "" {
		return "the top of the drive"
	}
	return dir
}

// sourceFile is the bytes this device saved at name: rclone's VFS cache
// file when the guard knows where that cache is, otherwise the mount
// path. The cache file is this device's own write, so a claim can copy
// it after the mount path has already been overwritten by another
// device's save. No second copy is made.
func (g *conflictGuard) sourceFile(name string) string {
	if p := g.cacheFile(name); p != "" {
		return p
	}
	if g.cacheDir != "" {
		// A mount path open can make rclone replace this device's dirty
		// bytes with a download of whatever is at the plain path now.
		return ""
	}
	return filepath.Join(g.mountDir, filepath.FromSlash(name))
}

// cacheFile is rclone's VFS cache file for a mount-relative path, or "".
// rclone stores it at <cache-dir>/vfs/<remote-name>[ {config} ]/<root>/<name>:
// extra backend options (the S3 endpoint, the keys) make the folder
// drive{XXXX} rather than drive, so a lookup that only tries "drive" misses
// the bytes this device just saved.
func (g *conflictGuard) cacheFile(name string) string {
	if g.cacheDir == "" {
		return ""
	}
	rel := filepath.FromSlash(name)
	rest := ""
	if _, after, ok := strings.Cut(g.fs, ":"); ok {
		rest = filepath.FromSlash(after)
	}
	var candidates []string
	if rest != "" {
		candidates = append(candidates, filepath.Join(g.cacheDir, "vfs", RcloneRemoteName, rest, rel))
		if matches, err := filepath.Glob(filepath.Join(g.cacheDir, "vfs", RcloneRemoteName+"*", rest, rel)); err == nil {
			candidates = append(candidates, matches...)
		}
	}
	candidates = append(candidates,
		filepath.Join(g.cacheDir, "vfs", RcloneRemoteName, rel),
		filepath.Join(g.cacheDir, RcloneRemoteName, rel),
	)
	for _, p := range candidates {
		if p == "" {
			continue
		}
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// hashMountFile is the md5 of the bytes the mount serves at path,
// read straight out of the VFS cache file those bytes live in: the
// same bytes the write-back will upload, with no second copy written
// anywhere. The read is capped at conflictProtectMax, so a save that
// grows while it is hashed is named (errProtectTooLarge) rather than
// hashed as a truncation.
func (g *conflictGuard) hashMountFile(path string) (string, error) {
	src := g.sourceFile(path)
	if src == "" {
		return "", fmt.Errorf("%w for %s", errNoCacheFile, path)
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	// MD5 is the content hash rclone records for the object (S3's ETag), so
	// it is the only hash both halves of the comparison can answer; this is
	// an identity check between two copies of the same bytes, not a
	// signature (see the md5 note on remoteHash).
	// nosemgrep: go.lang.security.audit.crypto.use_of_weak_crypto.use-of-md5
	h := md5.New()
	read, err := io.Copy(h, io.LimitReader(in, conflictProtectMax+1))
	if err != nil {
		return "", err
	}
	if read > conflictProtectMax {
		// One byte more than the cap was read, so the bytes are not
		// the whole save: the hash below would be of a truncated
		// file, and a conflict copy of that hash is a corrupt
		// version of the save it exists to keep.
		return "", fmt.Errorf("%w: %s", errProtectTooLarge, path)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hashPath(path string) (string, error) {
	in, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer in.Close()
	// nosemgrep: go.lang.security.audit.crypto.use_of_weak_crypto.use-of-md5
	h := md5.New()
	if _, err := io.Copy(h, in); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (s *pendingSave) dropHold() {
	if s == nil || s.holdPath == "" {
		return
	}
	_ = os.Remove(s.holdPath)
	s.holdPath = ""
}

// snapshotSave copies the bytes just hashed into a file the guard owns, so a
// later claim can still write them after rclone has dropped the VFS cache
// copy as stale.
func (g *conflictGuard) snapshotSave(name, hash string) string {
	src := g.sourceFile(name)
	if src == "" {
		return ""
	}
	dir := g.cacheDir
	if dir == "" {
		dir = os.TempDir()
	}
	dir = filepath.Join(dir, "conflict-hold")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	prefix := "h-"
	if len(hash) >= 8 {
		prefix = "h-" + hash[:8] + "-"
	}
	out, err := os.CreateTemp(dir, prefix)
	if err != nil {
		return ""
	}
	dst := out.Name()
	in, err := os.Open(src)
	if err != nil {
		out.Close()
		os.Remove(dst)
		return ""
	}
	defer in.Close()
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	if err != nil || closeErr != nil {
		os.Remove(dst)
		return ""
	}
	return dst
}

// errNoCacheFile is a save whose bytes are not in the VFS cache yet, or
// have been evicted. The pass leaves it unseen so the next pass can
// hash it; it is not a failure of the other saves in the same queue.
var errNoCacheFile = errors.New("no VFS cache file")

// errProtectTooLarge is a save that grew past the protection cap while
// it was being hashed. It is a named skip, not a failure of the pass.
var errProtectTooLarge = errors.New("the save grew past the protection cap while it was hashed")

const conflictSkipSourceChanged = "the save's bytes are no longer the ones this device saved, so they cannot be kept"

var errClaimSourceChanged = errors.New(conflictSkipSourceChanged)

// freeConflictName is the conflict name for path, starting at index: The index is where the search starts rather
// than the first name tried, because a caller that just found a name
// taken retries from the next one.
func freeConflictName(ctx context.Context, b conflictBackend, path, device string, start int) (string, error) {
	if start < 1 || start > conflictCopyLimit {
		return "", fmt.Errorf("conflict name index %d is not between 1 and %d for %s", start, conflictCopyLimit, path)
	}
	for i := start; i <= conflictCopyLimit; i++ {
		candidate := ConflictName(path, device)
		if i > 1 {
			candidate = ConflictName(path, fmt.Sprintf("%s %d", device, i))
		}
		exists, err := b.remoteHas(ctx, candidate)
		if err != nil {
			return "", fmt.Errorf("read the conflict name %s: %w", candidate, err)
		}
		if !exists {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("ran out of conflict names for %s", path)
}

// queueEntry is one upload in the mount's VFS queue, in rclone's own
// field names (the JSON keys come straight from vfs/queue).
type queueEntry struct {
	Name      string  `json:"name"`
	Size      int64   `json:"size"`
	ID        int     `json:"id"`
	Tries     int     `json:"tries"`
	Uploading bool    `json:"uploading"`
	Delay     float64 `json:"delay"`
	Expiry    float64 `json:"expiry"`
}

// queue is rclone's own list of this mount's pending uploads: the
// paths this device has saved and storage has not taken yet. It is
// the only handle on the window in which a conflicting save happens,
// and it is rclone's answer to the question, not a second index
// this product keeps.
func (c *rcClient) queue(ctx context.Context) ([]queueEntry, error) {
	params := map[string]string{}
	if c.fs != "" {
		params["fs"] = c.fs
	}
	var reply struct {
		Queue []queueEntry `json:"queue"`
	}
	if err := c.call(ctx, "vfs/queue", params, &reply); err != nil {
		return nil, err
	}
	if reply.Queue == nil {
		return []queueEntry{}, nil
	}
	return reply.Queue, nil
}

// remoteHas reports whether an object exists at the plain path.
// A missing object is an answer, not an error.
func (c *rcClient) remoteHas(ctx context.Context, name string) (bool, error) {
	var reply struct {
		Item json.RawMessage `json:"item"`
	}
	if err := c.call(ctx, "operations/stat", map[string]string{"fs": c.fs, "remote": name}, &reply); err != nil {
		return false, err
	}
	return string(reply.Item) != "null", nil
}

// parentContents names the files one folder of the remote holds. The
// folder is asked for first (operations/stat): a folder that is not
// there yet holds no paths and that is an answer, because the first
// save into a new folder queues before rclone has created the folder
// in storage. The listing itself is rclone's operations/list, which
// names files at that one level — the level the saves in it live at.
func (c *rcClient) parentContents(ctx context.Context, dir string) (map[string]bool, error) {
	if dir != "" {
		var statReply struct {
			Item json.RawMessage `json:"item"`
		}
		if err := c.call(ctx, "operations/stat", map[string]string{"fs": c.fs, "remote": dir}, &statReply); err != nil {
			if isRemoteMissing(err) {
				return map[string]bool{}, nil
			}
			return nil, err
		}
		if string(statReply.Item) == "null" {
			return map[string]bool{}, nil
		}
	}
	var reply struct {
		List []struct {
			Name  string `json:"Name"`
			IsDir bool   `json:"IsDir"`
		} `json:"list"`
	}
	if err := c.call(ctx, "operations/list", map[string]string{"fs": c.fs, "remote": dir}, &reply); err != nil {
		if isRemoteMissing(err) {
			return map[string]bool{}, nil
		}
		return nil, err
	}
	present := make(map[string]bool, len(reply.List))
	for _, entry := range reply.List {
		if !entry.IsDir {
			present[entry.Name] = true
		}
	}
	return present, nil
}

// remoteHash is the md5 of the object at the plain path, and "" when
// there is no object there. Existence is asked first: operations/hashsum
// on a path that is not there is an error, and a save that lands where
// nothing was is exactly the case the rule has to name, so "no object" is
// an answer and only a failed read is an error.
func (c *rcClient) remoteHash(ctx context.Context, name string) (string, error) {
	exists, err := c.remoteHas(ctx, name)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", nil
	}
	var reply struct {
		Hashsum []string `json:"hashsum"`
	}
	hashErr := c.call(ctx, "operations/hashsum", map[string]string{
		"fs": c.fs, "remote": name, "hashType": "md5",
	}, &reply)
	if hashErr == nil {
		hash, err := matchHashSum(reply.Hashsum, name)
		if err == nil && hash != "" {
			return hash, nil
		}
		hashErr = err
	}
	fp, fpErr := c.remoteFingerprint(ctx, name)
	if fpErr != nil {
		if hashErr != nil {
			return "", hashErr
		}
		return "", fpErr
	}
	return fp, nil
}

// remoteVersion is the object's size and mtime from operations/stat, and
// ok is false when there is no object at the plain path.
func (c *rcClient) remoteVersion(ctx context.Context, name string) (int64, time.Time, bool, error) {
	var reply struct {
		Item *struct {
			Size    int64     `json:"Size"`
			ModTime time.Time `json:"ModTime"`
		} `json:"item"`
	}
	if err := c.call(ctx, "operations/stat", map[string]string{"fs": c.fs, "remote": name}, &reply); err != nil {
		return 0, time.Time{}, false, err
	}
	if reply.Item == nil {
		return 0, time.Time{}, false, nil
	}
	return reply.Item.Size, reply.Item.ModTime, true, nil
}

// sameVersion reports whether an object is the file this device hashed.
// The mtime is compared to the second because a backend may keep less
// precision than the local filesystem does.
func sameVersion(size int64, modTime time.Time, localSize int64, localMtime time.Time) bool {
	if size != localSize || localMtime.IsZero() {
		return false
	}
	d := modTime.Sub(localMtime)
	return d < time.Second && d > -time.Second
}

// remoteFingerprint is the object's ETag or version when MD5 is missing
// (multipart S3 uploads, web uploads). rclone's operations/stat ID is the
// S3 ETag; size and modtime are the fallback when even that is empty.
func (c *rcClient) remoteFingerprint(ctx context.Context, name string) (string, error) {
	var reply struct {
		Item struct {
			ID      string            `json:"ID"`
			Size    int64             `json:"Size"`
			ModTime string            `json:"ModTime"`
			Hashes  map[string]string `json:"Hashes"`
		} `json:"item"`
	}
	if err := c.call(ctx, "operations/stat", map[string]string{
		"fs": c.fs, "remote": name,
	}, &reply); err != nil {
		return "", err
	}
	if md5sum := reply.Item.Hashes["MD5"]; md5sum != "" {
		return md5sum, nil
	}
	if reply.Item.ID != "" {
		return "etag:" + reply.Item.ID, nil
	}
	return fmt.Sprintf("ver:%d:%s", reply.Item.Size, reply.Item.ModTime), nil
}

// matchHashSum picks the one hash of name out of a hashsum reply. The
// reply echoes other paths when the remote names a prefix, so the
// entry is matched by the name that follows the hash rather than by
// taking the first line.
func matchHashSum(lines []string, name string) (string, error) {
	base := remoteBase(name)
	var fallback string
	for _, line := range lines {
		hash, path, ok := splitHashLine(line)
		if !ok {
			continue
		}
		// The remote that was asked for is matched first, so two files
		// that share a base name in different folders cannot trade
		// hashes. The base name is the fallback for a backend that
		// answers with the name its fs was asked for, and only when it
		// is the only entry: a reply carrying other paths is not
		// answered by guessing which one was meant.
		if path == name {
			return hash, nil
		}
		if path == base && fallback == "" {
			fallback = hash
		}
	}
	if fallback != "" && len(lines) == 1 {
		return fallback, nil
	}
	return "", fmt.Errorf("no md5 for %q in %v", name, lines)
}

// splitHashLine splits one hashsum reply line into its hash and its path.
// The hash is the first field and the path is the rest of the line, because
// a path may contain spaces: "report (conflict, mac).txt" is one name, not
// the word after the hash.
func splitHashLine(line string) (hash, path string, ok bool) {
	// rclone prints "hash  path" with two spaces. An empty MD5 (multipart
	// ETag without md5 metadata) is "  path", which TrimSpace would turn
	// into a path-only line and then into an error. Keep the two-space
	// split so an empty hash is still a hash.
	trimmed := strings.TrimRight(line, " \t\n")
	if trimmed == "" {
		return "", "", false
	}
	if i := strings.Index(trimmed, "  "); i >= 0 {
		return strings.TrimSpace(trimmed[:i]), strings.TrimSpace(trimmed[i+2:]), true
	}
	i := strings.IndexAny(trimmed, " \t")
	if i <= 0 {
		return "", "", false
	}
	return trimmed[:i], strings.TrimSpace(trimmed[i+1:]), true
}

// remoteBase is the last segment of a '/'-separated remote path.
func remoteBase(name string) string {
	if i := strings.LastIndex(name, "/"); i >= 0 {
		return name[i+1:]
	}
	return name
}

// forget drops one path from rclone's VFS directory cache so the next
// operations/stat or operations/hashsum reads storage rather than the
// bytes this device still has cached.
func (c *rcClient) forget(ctx context.Context, name string) error {
	var reply map[string]any
	return c.call(ctx, "vfs/forget", map[string]string{"file": name}, &reply)
}

// copyLocalToRemote copies one file this device can read into the
// mount's own remote with rclone's own copy operation: the object
// store already holds the upload path and the credentials, and rclone
// is already the thing that talks to it, so this is not a second way
// to write to storage. srcRemote is relative to srcRoot, which for a
// conflict copy is this device's own mount.
func (c *rcClient) copyLocalToRemote(ctx context.Context, srcRoot, srcRemote, dstRemote string) error {
	srcFs := srcRoot
	if filepath.IsAbs(srcRoot) {
		// Force the local backend. rclone's cache folder is named
		// drive{XXXX} when the remote has extra config, and `{XXXX}`
		// is also rclone's connection-string config syntax.
		srcFs = ":local:" + srcRoot
	}
	var reply map[string]any
	return c.call(ctx, "operations/copyfile", map[string]string{
		"srcFs":     srcFs,
		"srcRemote": srcRemote,
		"dstFs":     c.fs,
		"dstRemote": dstRemote,
	}, &reply)
}

// isRemoteMissing reports a path rclone does not have yet: a listing or
// stat of a prefix that has never been written is "no files", not a
// failed pass.
func isRemoteMissing(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "directory not found")
}

// ConflictGuardStatePath is where the running guard reports how far
// behind it is: one small file inside this device's own config
// folder, written every pass, so `drive status` can name a backlog
// without talking to the mount.
func ConflictGuardStatePath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "conflict-guard.json")
}

// conflictGuardState is the whole content of the state file: the
// backlog the pass just finished saw, and when it saw it. It is a
// status file for `drive status`, not a record the guard reads back.
type conflictGuardState struct {
	// Behind is how many saves in flight no pass has taken in yet.
	Behind int `json:"behind"`
	// UpdatedAt is when the pass ran, so a stale file is known to be
	// stale rather than read as an answer.
	UpdatedAt time.Time `json:"updatedAt"`
}

// writeConflictGuardState records the backlog behind the pass just
// finished. The write is a temp file and a rename, so a reader never
// sees a half-written file.
func writeConflictGuardState(path string, behind int, now time.Time) error {
	b, err := json.Marshal(conflictGuardState{Behind: behind, UpdatedAt: now.UTC()})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "conflict-guard-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	return os.Rename(tmpName, path)
}

// conflictGuardBehind is how many saves the guard said it is behind,
// and -1 when there is no answer to trust: no file (the guard is not
// running), a file older than conflictStateFresh (the guard stopped
// reporting), or a file that is not this product's JSON (not an
// answer either). -1 is "no line", not an error: the status's three
// questions do not include the guard, and the guard's own failures
// are named on the mount's log.
func conflictGuardBehind(path string, now time.Time) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return -1
	}
	var s conflictGuardState
	if err := json.Unmarshal(b, &s); err != nil {
		return -1
	}
	if s.UpdatedAt.IsZero() || now.Sub(s.UpdatedAt) > conflictStateFresh {
		return -1
	}
	return s.Behind
}

// RunConflictLoop is the guard, running inside the mount process for
// as long as the mount does. It is started by mountForeground and
// stopped with the mount; it is not a second daemon and not a script.
// One guard keeps its state across passes, so a save in its upload
// window is watched from queue to landing. Every pass reports what it
// did: a conflict copy it wrote, a save the rule left alone and the
// reason, or a real failure — and records its backlog in the state
// file for `drive status`. The channel is buffered so a busy loop never
// blocks on a reader, and the same message is reported at most once per
// conflictReportEvery.
func RunConflictLoop(ctx context.Context, device, mountDir, cacheDir, fs, statePath string, c conflictBackend) <-chan error {
	msgs := make(chan error, 64)
	go func() {
		defer close(msgs)
		guard := newConflictGuard(device, mountDir)
		guard.cacheDir, guard.fs = cacheDir, fs
		ticker := time.NewTicker(conflictInterval)
		defer ticker.Stop()
		lastReport := make(map[string]time.Time)
		report := func(format string, args ...any) {
			line := fmt.Sprintf(format, args...)
			if time.Since(lastReport[line]) < conflictReportEvery {
				return
			}
			lastReport[line] = time.Now()
			select {
			case msgs <- fmt.Errorf("%s", line):
			default:
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			passCtx, cancel := context.WithTimeout(ctx, conflictContextTimeout)
			res, err := guard.pass(passCtx, c)
			cancel()
			if err != nil {
				report("%v", err)
			} else if err := writeConflictGuardState(statePath, res.Behind, time.Now()); err != nil {
				report("conflict: write the guard state: %v", err)
			}
			// A conflict copy written means another device's save landed on
			// top of this one: the earlier save survives under its own name.
			for _, claim := range res.Claimed {
				report("kept the save that landed first: %s (the other device saved %s)",
					claim.Remote, claim.LosingPath)
			}
			// A skip is a save this device could not protect. It is named so
			// a person can read the reason and act, because a silent skip is
			// a lost save nobody heard about.
			for _, skip := range res.Skipped {
				report("could not protect %s: %s", skip.Remote, skip.Reason)
			}
		}
	}()
	return msgs
}
