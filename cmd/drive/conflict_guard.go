package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
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
//      the one that landed and there is nothing to protect.
//   3. Different means the other device's save landed. The plain
//      path holds the other device's bytes and this device's bytes
//      are gone from storage, so the staged copy is uploaded as
//      the conflict copy under the losing device's own name.
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

// conflictClaimPolls is how long an already-landed path is watched
// before the guard gives up on it. A landed path whose object hash
// still matches the version that preceded the save is not a decided
// conflict, and staying on it forever would grow the map on a mount
// that never stops.
const conflictClaimPolls = 20

// conflictCopyLimit caps the numbered conflict copies for one path,
// so a repeated conflict with the same device name cannot grow
// without end.
const conflictCopyLimit = 99

// pendingSave is one save in flight: this device's own hash, the
// object hash that preceded the save, and where the bytes are
// staged.
type pendingSave struct {
	// hash is the md5 of this device's bytes, taken through the
	// mount while the upload was still queued.
	hash string
	// previous is the object hash at the plain path when the save
	// was first seen in the queue. It is what the upload is
	// allowed to replace.
	previous string
	// staged is the path, relative to the staging root, of this
	// device's bytes.
	staged string
	// polls is how many passes this path has been watched since its
	// upload left the queue without landing.
	polls int
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
	// Skipped is a save the rule left alone because staging it
	// would have cost more than it protects. Named, so it is
	// visible.
	Skipped []string
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
	// plain path held before.
	for name := range inFlight {
		if _, ok := g.seen[name]; ok {
			continue
		}
		staged, hash, err := g.stage(name)
		if err != nil {
			return res, err
		}
		if staged == "" {
			res.Skipped = append(res.Skipped, name)
			continue
		}
		previous, err := b.remoteHash(ctx, name)
		if err != nil {
			return res, fmt.Errorf("conflict: read %s before the save lands: %w", name, err)
		}
		g.seen[name] = &pendingSave{hash: hash, previous: previous, staged: staged}
	}

	// Steps 2 and 3: a path that left the queue has landed. Compare
	// what is at the plain path with this device's bytes.
	for name, save := range g.seen {
		if inFlight[name] {
			continue
		}
		save.polls++
		landed, err := b.remoteHash(ctx, name)
		if err != nil {
			return res, fmt.Errorf("conflict: read %s after the save landed: %w", name, err)
		}
		switch {
		case landed == save.hash:
			// This device's save is the one that landed.
			delete(g.seen, name)
		case landed == "" || landed == save.previous:
			// Nothing has landed where this save was going, or the
			// object is the version that preceded the save: not a
			// decided conflict. The queue released the path on an
			// error, or the upload is still on its way, so it is
			// watched a little longer.
			if save.polls >= conflictClaimPolls {
				delete(g.seen, name)
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
		// it for its own listing.
		if err := b.refresh(ctx, false); err != nil {
			return res, fmt.Errorf("conflict: refresh after claiming: %w", err)
		}
	}
	return res, nil
}

// claim writes the staged bytes under the conflict name and stops
// watching the path.
func (g *conflictGuard) claim(ctx context.Context, b conflictBackend, path string, save *pendingSave) (ConflictCopy, error) {
	name, err := freeConflictName(ctx, b, path, g.device)
	if err != nil {
		return ConflictCopy{}, fmt.Errorf("conflict: %w", err)
	}
	if err := b.copyLocalToRemote(ctx, g.stagingRoot, save.staged, name); err != nil {
		return ConflictCopy{}, fmt.Errorf("conflict: copy %s to %s: %w", path, name, err)
	}
	delete(g.seen, path)
	return ConflictCopy{Remote: name, LosingPath: path, Device: g.device}, nil
}

// freeConflictName is the conflict name for path, with a number
// appended when that name is already taken: a device that loses the
// same file twice must not overwrite the copy of the first loss.
func freeConflictName(ctx context.Context, b conflictBackend, path, device string) (string, error) {
	candidate := ConflictName(path, device)
	exists, err := b.remoteHas(ctx, candidate)
	if err != nil {
		return "", fmt.Errorf("read the conflict name %s: %w", candidate, err)
	}
	if !exists {
		return candidate, nil
	}
	for i := 2; i <= conflictCopyLimit; i++ {
		candidate := ConflictName(path, fmt.Sprintf("%s %d", device, i))
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
// staging root) and the md5 of what it copied. An empty path means
// the save was left alone (too large to stage) and the caller names
// the skip.
func (g *conflictGuard) stage(path string) (staged, hash string, err error) {
	mounted := filepath.Join(g.mountDir, filepath.FromSlash(path))
	info, err := os.Stat(mounted)
	if err != nil {
		return "", "", fmt.Errorf("conflict: read %s while it is queued: %w", mounted, err)
	}
	if !info.Mode().IsRegular() {
		// A directory or a symlink is not a save whose bytes can
		// be staged.
		return "", "", fmt.Errorf("conflict: %s is a %s, not a regular file", mounted, info.Mode().Type())
	}
	if info.Size() > conflictStageMax {
		return "", "", nil
	}
	dest := filepath.Join(g.stagingRoot, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return "", "", fmt.Errorf("conflict: create the staging dir for %s: %w", dest, err)
	}
	staged, hash, err = copyFileWithHash(mounted, dest, g.stagingRoot)
	if err != nil {
		return "", "", fmt.Errorf("conflict: stage %s: %w", path, err)
	}
	return staged, hash, nil
}

// copyFileWithHash writes src to dst, inside stagingRoot, and returns
// the staged path relative to that root and the md5 of the bytes. The
// path is relative to the staging root because that is what an
// operations/copyfile source remote is relative to. The hash is of the
// bytes as read through the mount, which is what this device saved, so
// the comparison with the object's hash is a comparison of the same
// bytes.
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
	h := md5.New()
	if _, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(in, conflictStageMax+1)); err != nil {
		out.Close()
		return "", "", err
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
	var reply struct {
		Queue []queueEntry `json:"queue"`
	}
	if err := c.call(ctx, "vfs/queue", map[string]string{"fs": c.fs}, &reply); err != nil {
		return nil, err
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
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[1] == name || fields[1] == base {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("no md5 for %q in %v", name, lines)
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
// window is watched from queue to landing; every error is reported on
// the returned channel with a named cause, so one bad pass neither
// takes the mount down nor passes unnoticed.
func RunConflictLoop(ctx context.Context, device, mountDir, stagingRoot string, c conflictBackend) <-chan error {
	errs := make(chan error, 1)
	go func() {
		defer close(errs)
		guard := newConflictGuard(device, mountDir, stagingRoot)
		ticker := time.NewTicker(conflictInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			passCtx, cancel := context.WithTimeout(ctx, conflictContextTimeout)
			_, err := guard.pass(passCtx, c)
			cancel()
			if err != nil {
				select {
				case errs <- err:
				default:
				}
			}
		}
	}()
	return errs
}
