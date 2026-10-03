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
// Every pass is three steps against the running mount:
//
//   1. vfs/queue names this device's own uploads that storage has
//      not taken yet. A path there is a save in flight, so the
//      device's bytes are still on this machine (staged below),
//      and the queue has not released the path yet.
//   2. A path that leaves the queue has landed. The guard reads
//      the object's hash at the plain path and compares it with
//      this device's own hash. Equal means this device's save is
//      the one that landed, but the save is not decided yet: the
//      other device's own write-back timer may not have fired, so
//      the plain path stays watched for conflictWinPolls passes
//      before the win is declared and the staged copy is dropped.
//   3. A hash that is neither this device's bytes nor the version
//      that was there before means the other device's save landed.
//      The plain path holds the other device's bytes and this
//      device's bytes are gone from storage, so the staged copy is
//      uploaded as the conflict copy under the losing device's own
//      name.
//
// The rule never deletes, never renames and never guesses: a hash
// that is neither this device's bytes nor the version that was
// there before is the only thing that writes a conflict copy, and
// the bytes written are the ones this device saved, read back
// from its own mount while they were still there.

// conflictInterval is the guard's period. The write-back window is
// 5s, so half a second is well inside it and the guard is still one
// system call per half second on a machine that is doing nothing
// else.
const conflictInterval = 500 * time.Millisecond

// conflictContextTimeout bounds one pass, so a wedged remote-control
// call cannot hold the guard forever.
const conflictContextTimeout = 30 * time.Second

// conflictStageMax bytes is the largest save the guard stages. This
// device's bytes are copied out of the VFS cache before its upload
// lands, and that copy is only needed while the path is in the queue.
// A larger file is left alone rather than copied, and the skip is
// reported: a named skip is a thing a person can read and act on,
// a silent one is a lost save nobody heard about.
const conflictStageMax = 64 << 20

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
// upload that landed a moment ago. The plain path is polled every
// conflictInterval, so conflictWinPolls passes cover that window with
// margin for rclone's own scheduling.
const conflictWinPolls = 20

// conflictReportEvery is the least time between two reports of the
// same cause, so a persistent failure keeps a named heartbeat on the
// mount's log rather than one line and then silence.
const conflictReportEvery = time.Minute

// conflictCopyLimit caps the numbered conflict copies for one path,
// so a repeated conflict with the same device name cannot grow
// without end.
const conflictCopyLimit = 99

// pendingSave is one save in flight: this device's own hash, the
// object hash that preceded the save, and where the bytes are staged.
// A save this device cannot protect is recorded here too, with the
// reason named, so the skip is said once instead of on every pass.
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
	// staged is the path, relative to the staging root, of this
	// device's bytes.
	staged string
	// reason names a save the rule left alone, and is empty for a
	// save the rule protects.
	reason string
	// reported is set once the skip has been named, so one skip is
	// one line rather than one line per pass for the life of the
	// upload.
	reported bool
	// polls is how many passes this path has been watched since its
	// upload left the queue without landing, while the plain path still
	// holds the version that preceded the save.
	polls int
	// winPolls is non-zero once this device's own save has landed at the
	// plain path. While it is ticking, the guard keeps watching for an
	// overwrite by another device rather than declaring the save the winner
	// the instant it sees its own bytes: an upload can land on top of an
	// own upload seconds later and still be within one sync window.
	winPolls int
	// stagedMtime and stagedSize are the mtime and size of the file this
	// device staged. The bytes the upload will carry are the bytes on this
	// device's mount at upload time, so a save written again before the
	// upload fires is re-staged on change, lest the staged copy be an older
	// version than the one that gets overwritten.
	stagedMtime time.Time
	stagedSize  int64
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
	// copyLocalToRemote uploads one staged file into the mount's
	// own remote, under dstRemote, with rclone's own copy operation.
	copyLocalToRemote(ctx context.Context, stagingRoot, srcRemote, dstRemote string) error
	// refresh asks rclone to refresh the mount's directory cache,
	// so the conflict copy is visible through the mount rather
	// than only in storage. recursive is the fill's own choice and
	// is never true here: a conflict copy is always in the folder
	// whose save was lost, so only that folder's listing changed.
	refresh(ctx context.Context, recursive bool) error
}

// ConflictResult is what one guard pass did, so a proof and a log
// line can read what happened without re-running it.
type ConflictResult struct {
	// Watched is the number of saves in flight the pass saw.
	Watched int
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
// or it was larger than the staging cap.
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
// mount.
type conflictGuard struct {
	device      string
	mountDir    string
	stagingRoot string
	seen        map[string]*pendingSave
}

// newConflictGuard builds the guard for one mount. The staging root
// is where this device's bytes are kept for the moments they might
// still be lost, and it is inside this device's own drive folder
// (not the mount dir), so nothing staged is ever visible in the
// drive.
func newConflictGuard(device, mountDir, stagingRoot string) *conflictGuard {
	return &conflictGuard{
		device:      device,
		mountDir:    mountDir,
		stagingRoot: stagingRoot,
		seen:        map[string]*pendingSave{},
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

	// Step 1: every path in the queue is a save whose bytes are
	// still on this machine. Stage them and remember what the
	// plain path held before. A save that cannot be staged is
	// named and left alone rather than failing the pass: one save
	// that is gone, or is not a regular file, must not stop the
	// other saves in the same queue from being protected.
	for name := range inFlight {
		if save, ok := g.seen[name]; ok {
			// A path already recorded is not staged again from scratch, but it
			// is re-staged when this device has written it again, so the bytes
			// protected are the ones the upload will carry rather than the ones
			// staged at first sight. The mtime and size are rclone's own signal
			// that the VFS cache changed, so the re-stage is one stat per
			// watched path instead of a re-copy on every pass.
			if save.reason == "" && g.mountChanged(name, save) {
				staged, hash, reason, err := g.stage(name)
				if err != nil {
					return res, err
				}
				if reason == "" {
					info := g.mountStat(name)
					save.staged, save.hash = staged, hash
					save.stagedMtime, save.stagedSize = info.modTime, info.size
				} else {
					// The save can no longer be staged (it grew past
					// the cap, or it stopped being a regular file), so
					// the bytes already staged are no longer the bytes
					// the upload will carry. Claiming them would write a
					// conflict copy of a version nobody saved, so the
					// save is named as one the rule leaves alone.
					save.reason = reason
					save.staged = ""
					g.releaseStaged(staged)
				}
			}
			// A skip is named once: the same line every 500ms for the life of
			// an upload is not a thing a person can read.
			if save.reason != "" && !save.reported {
				res.Skipped = append(res.Skipped, ConflictSkip{Remote: name, Reason: save.reason})
				save.reported = true
			}
			continue
		}
		staged, hash, reason, err := g.stage(name)
		if err != nil {
			return res, err
		}
		if reason != "" {
			g.seen[name] = &pendingSave{reason: reason, reported: true}
			res.Skipped = append(res.Skipped, ConflictSkip{Remote: name, Reason: reason})
			continue
		}
		previous, err := b.remoteHash(ctx, name)
		if err != nil {
			return res, fmt.Errorf("conflict: read %s before the save lands: %w", name, err)
		}
		info := g.mountStat(name)
		g.seen[name] = &pendingSave{
			hash:        hash,
			previous:    previous,
			staged:      staged,
			stagedMtime: info.modTime,
			stagedSize:  info.size,
		}
	}

	// Steps 2 and 3: a path that left the queue has landed. Compare
	// what is at the plain path with this device's bytes.
	for name, save := range g.seen {
		if inFlight[name] {
			continue
		}
		if save.reason != "" {
			// The queue has released a save the rule left alone, so this
			// device cannot protect it. Drop it and its staged bytes:
			// holding the entry would grow the map on a mount that never
			// stops, and the staged bytes are a local copy of a save that
			// is already gone.
			g.drop(name, save)
			continue
		}
		save.polls++
		landed, err := b.remoteHash(ctx, name)
		if err != nil {
			return res, fmt.Errorf("conflict: read %s after the save landed: %w", name, err)
		}
		switch {
		case landed == save.hash:
			// This device's save is the one that landed. An overwrite can
			// still land on top of it for the whole sync window after it,
			// because the other device's own write-back timer has not fired
			// yet, so the guard does not declare a win the moment it sees
			// its own bytes: it watches for conflictWinPolls passes and only
			// then drops the entry and its staged copy.
			save.winPolls++
			if save.winPolls >= conflictWinPolls {
				g.drop(name, save)
			}
		case landed == "" || landed == save.previous:
			// Nothing has landed where this save was going, or the
			// object is the version that preceded the save: not a
			// decided conflict. The queue released the path on an
			// error, or the upload is still on its way, so it is
			// watched a little longer.
			if save.polls >= conflictClaimPolls {
				g.drop(name, save)
			}
		default:
			// The plain path holds a version that is neither this
			// device's bytes nor the version that preceded the save:
			// the other device's save landed. This device's bytes
			// survive as the conflict copy.
			claim, err := g.claim(ctx, b, name, save)
			if err != nil {
				return res, err
			}
			res.Claimed = append(res.Claimed, claim)
		}
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

// claim writes the staged bytes under the conflict name and stops
// watching the path. The name is looked up, the copy is read back,
// and a name that holds some other writer's bytes is retried under
// the next number: two mounts answering to the same device name can
// look at the same free name in the same instant, so a conflict copy
// is only this device's save once the object says so.
func (g *conflictGuard) claim(ctx context.Context, b conflictBackend, path string, save *pendingSave) (ConflictCopy, error) {
	for index := 1; ; index++ {
		name, err := freeConflictName(ctx, b, path, g.device, index)
		if err != nil {
			return ConflictCopy{}, fmt.Errorf("conflict: %w", err)
		}
		if err := b.copyLocalToRemote(ctx, g.stagingRoot, save.staged, name); err != nil {
			return ConflictCopy{}, fmt.Errorf("conflict: copy %s to %s: %w", path, name, err)
		}
		kept, err := b.remoteHash(ctx, name)
		if err != nil {
			return ConflictCopy{}, fmt.Errorf("conflict: read %s back: %w", name, err)
		}
		if kept == save.hash {
			delete(g.seen, path)
			g.releaseStaged(save.staged)
			return ConflictCopy{Remote: name, LosingPath: path, Device: g.device}, nil
		}
		if index >= conflictCopyLimit {
			return ConflictCopy{}, fmt.Errorf("conflict: every conflict name for %s holds another writer's bytes", path)
		}
	}
}

// drop stops watching a path and removes the staged copy that guarded it.
// It is how the watch list stays the size of the saves actually in flight,
// and how a staged copy does not outlive the save it was staged for.
func (g *conflictGuard) drop(name string, save *pendingSave) {
	delete(g.seen, name)
	g.releaseStaged(save.staged)
}

// releaseStaged removes one staged copy. A save that was never staged (a
// named skip) has nothing to remove, and a staged copy that is already
// gone is not an error: the point is that nothing accumulates in this
// device's own config folder.
func (g *conflictGuard) releaseStaged(staged string) {
	if staged == "" {
		return
	}
	_ = os.Remove(filepath.Join(g.stagingRoot, filepath.FromSlash(staged)))
}

// mountStat is the size and mtime of a path as this device's mount serves
// it. A path that cannot be stated is reported as the zero value, which
// mountChanged reads as "unchanged", so a stat that fails never triggers a
// re-stage on its own.
func (g *conflictGuard) mountStat(name string) mountFileInfo {
	info, err := os.Stat(filepath.Join(g.mountDir, filepath.FromSlash(name)))
	if err != nil {
		return mountFileInfo{}
	}
	return mountFileInfo{modTime: info.ModTime(), size: info.Size()}
}

// mountFileInfo is the part of a file's stat the guard compares between
// passes: when either changes, this device has written the file again.
type mountFileInfo struct {
	modTime time.Time
	size    int64
}

// mountChanged reports whether this device's mount now serves different
// bytes at the path than the ones staged. rclone's VFS updates the mtime
// when the file is written, so the mtime and the size are rclone's own
// signal that the write-back upload will carry newer bytes than the staged
// copy holds.
func (g *conflictGuard) mountChanged(name string, save *pendingSave) bool {
	info := g.mountStat(name)
	if info.modTime.IsZero() || save.stagedMtime.IsZero() {
		return false
	}
	return !info.modTime.Equal(save.stagedMtime) || info.size != save.stagedSize
}

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

// stage copies this device's bytes out of the mount while its upload
// is still queued, and returns the staged path (relative to the
// staging root), the md5 of what it copied and a skip reason.
//
// A non-empty reason is a save the rule leaves alone, named: the save
// is not in the drive any more, it is not a regular file, or it is
// over the staging cap. None of those is a failure of the pass, and
// none of them may be silent, so the caller reports them once and
// protects the saves it can. Only a real failure (a staging
// directory that cannot be made, a read that fails) is an error.
func (g *conflictGuard) stage(path string) (staged, hash, reason string, err error) {
	mounted := filepath.Join(g.mountDir, filepath.FromSlash(path))
	info, err := os.Stat(mounted)
	if err != nil {
		// The save was removed between the queue listing and the
		// read: the operator took it out of the drive, so there is
		// nothing to protect and nothing has failed.
		return "", "", fmt.Sprintf("the save is not in the drive any more: %v", err), nil
	}
	if !info.Mode().IsRegular() {
		// A directory or a symlink is not a save whose bytes can
		// be staged.
		return "", "", fmt.Sprintf("it is a %s, not a regular file", info.Mode().Type()), nil
	}
	if info.Size() > conflictStageMax {
		return "", "", fmt.Sprintf("%d bytes is over the %d-byte staging cap", info.Size(), conflictStageMax), nil
	}
	dest := filepath.Join(g.stagingRoot, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return "", "", "", fmt.Errorf("conflict: create the staging dir for %s: %w", dest, err)
	}
	staged, hash, err = copyFileWithHash(mounted, dest, g.stagingRoot)
	if errors.Is(err, errStageTooLarge) {
		// The save grew past the cap between the size check and the
		// copy, so the staged bytes would be a truncated file with a
		// hash that is not the object's, and a conflict copy made of
		// them would be a corrupt version of the save it exists to
		// keep.
		return "", "", fmt.Sprintf("the save grew past the %d-byte staging cap while it was staged", conflictStageMax), nil
	}
	if err != nil {
		return "", "", "", fmt.Errorf("conflict: stage %s: %w", path, err)
	}
	return staged, hash, "", nil
}

// errStageTooLarge is a save that grew past the staging cap while it
// was being staged. It is a named skip, not a failure of the pass.
var errStageTooLarge = errors.New("the save grew past the staging cap while it was staged")

// copyFileWithHash writes src to dst, inside stagingRoot, and returns
// the staged path relative to that root and the md5 of the bytes. The
// path is relative to the staging root because that is what an
// operations/copyfile source remote is relative to. The hash is of the
// bytes as read through the mount, which is what this device saved, so
// the comparison with the object's hash is a comparison of the same
// bytes.
//
// The hash is md5 because that is the hash the other side of the
// comparison already has: operations/hashsum with hashType md5 reads the
// content hash rclone records for the object, which on S3 is the ETag. A
// stronger algorithm would answer a different question and the two halves
// would never compare equal. It is an identity check between two copies of
// the same bytes, not a signature, so MD5's collision weakness is not the
// property being relied on — the copy written to storage is verified by
// reading the written object back and comparing its hash (claim), and an
// attacker who could stage bytes here can already write to the drive.
func copyFileWithHash(src, dst, stagingRoot string) (string, string, error) {
	in, err := os.Open(src)
	if err != nil {
		return "", "", err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", "", err
	}
	// MD5 is the content hash rclone records for the object (S3's ETag), so
	// it is the only hash both halves of the comparison can answer; this is
	// an identity check between two copies of the same bytes, not a
	// signature (see copyFileWithHash).
	// nosemgrep: go.lang.security.audit.crypto.use_of_weak_crypto.use-of-md5
	h := md5.New()
	copied, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(in, conflictStageMax+1))
	if err != nil {
		out.Close()
		return "", "", err
	}
	if copied > conflictStageMax {
		// One byte more than the cap was read, so the bytes are not
		// the whole save: the hash below would be of a truncated
		// file, and a conflict copy of that hash is a corrupt
		// version of the save it exists to keep.
		out.Close()
		os.Remove(dst)
		return "", "", fmt.Errorf("%w: %s", errStageTooLarge, dst)
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return "", "", err
	}
	if err := out.Close(); err != nil {
		return "", "", err
	}
	rel, err := filepath.Rel(stagingRoot, dst)
	if err != nil {
		return "", "", err
	}
	return filepath.ToSlash(rel), hex.EncodeToString(h.Sum(nil)), nil
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
	if err := c.call(ctx, "operations/hashsum", map[string]string{
		"fs": c.fs, "remote": name, "hashType": "md5",
	}, &reply); err != nil {
		return "", err
	}
	return matchHashSum(reply.Hashsum, name)
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
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return "", "", false
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

// copyLocalToRemote copies one staged file into the mount's own
// remote with rclone's own copy operation: the object store already
// holds the upload path and the credentials, and rclone is already
// the thing that talks to it, so this is not a second way to write
// to storage.
func (c *rcClient) copyLocalToRemote(ctx context.Context, stagingRoot, srcRemote, dstRemote string) error {
	var reply map[string]any
	return c.call(ctx, "operations/copyfile", map[string]string{
		"srcFs":     stagingRoot,
		"srcRemote": srcRemote,
		"dstFs":     c.fs,
		"dstRemote": dstRemote,
	}, &reply)
}

// RunConflictLoop is the guard, running inside the mount process for
// as long as the mount does. It is started by mountForeground and
// stopped with the mount; it is not a second daemon and not a script.
// One guard keeps its state across passes, so a save in its upload
// window is watched from queue to landing. Every pass reports what it
// did: a conflict copy it wrote, a save the rule left alone and the
// reason, or a real failure. The channel is buffered so a busy loop never
// blocks on a reader, and the same message is reported at most once per
// conflictReportEvery.
func RunConflictLoop(ctx context.Context, device, mountDir, stagingRoot string, c conflictBackend) <-chan error {
	msgs := make(chan error, 64)
	go func() {
		defer close(msgs)
		guard := newConflictGuard(device, mountDir, stagingRoot)
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
