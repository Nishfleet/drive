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
	"sync"
	"time"
)

const conflictInterval = 500 * time.Millisecond

const conflictContextTimeout = 30 * time.Second

const conflictSightMax = 100

const conflictPollMax = 100

const conflictProtectMax = 64 << 20

const conflictWatchWindow = 40 * time.Second

const conflictClaimPolls = int(conflictWatchWindow / conflictInterval)

const conflictWinPolls = int(conflictWatchWindow / conflictInterval)

const conflictHashFailPolls = 10

const conflictReportEvery = time.Minute

const conflictCopyLimit = 99

const conflictStateFresh = 5 * time.Second

type pendingSave struct {
	hash          string
	previous      string
	stat          mountFileInfo
	reason        string
	reported      bool
	polls         int
	winPolls      int
	byFingerprint bool
	hashFails     int
}

type conflictBackend interface {
	queue(ctx context.Context) ([]queueEntry, error)
	remoteHas(ctx context.Context, name string) (bool, error)
	remoteHash(ctx context.Context, name string) (string, error)
	remoteVersion(ctx context.Context, name string) (size int64, modTime time.Time, ok bool, err error)
	parentContents(ctx context.Context, dir string) (map[string]bool, error)
	copyLocalToRemote(ctx context.Context, srcRoot, srcRemote, dstRemote string) error
	refresh(ctx context.Context, recursive bool) error
	// upstream: https://github.com/rclone/rclone/blob/v1.75.2/vfs/dir.go#L809-L815 — vfs/refresh marks the directory cache stale before re-listing, and #L526-L540 is the re-list whose error a refresh while storage is down fails later opens with.
	reachable(ctx context.Context) error
}

// ConflictResult is what one guard pass did, so a proof and a log line can read what happened without re-running it.
type ConflictResult struct {
	Watched int
	Behind  int
	Claimed []ConflictCopy
	Skipped []ConflictSkip
}

// ConflictSkip is one save the rule did not protect, and the reason: the save was not in the drive any more, it was not a regular file, or it was larger than the protection cap.
type ConflictSkip struct {
	Remote string
	Reason string
}

// ConflictCopy is one conflict copy: the name the losing save is kept under and the device that lost it.
type ConflictCopy struct {
	Remote     string
	LosingPath string
	Device     string
}

// conflictGuard: one goroutine (the decide loop) owns seen, order and cursor; the sight loop talks to it only through staged, mirrored in merged. Both look into synced.
type conflictGuard struct {
	device      string
	mountDir    string
	cacheDir    string
	fs          string
	stageMu     sync.Mutex
	staged      map[string]*pendingSave
	stagedOrder []string
	merged      map[string]bool
	// hasSightLoop says a sight loop is running beside this guard, so pass() leaves the sighting to it. The old sole-pass shape (the tests drive pass() directly) sights inside the pass itself.
	hasSightLoop bool
	seen         map[string]*pendingSave
	order        []string
	cursor       int
	syncedMu     sync.Mutex
	synced       map[string]string
}

func newConflictGuard(device, mountDir string) *conflictGuard {
	return &conflictGuard{
		device:   device,
		mountDir: mountDir,
		staged:   map[string]*pendingSave{},
		merged:   map[string]bool{},
		seen:     map[string]*pendingSave{},
		synced:   map[string]string{},
	}
}

// SightLoop tells the guard that a sight loop is running: pass() then leaves the queue sighting to it.
func (g *conflictGuard) SightLoop() {
	g.hasSightLoop = true
}

func (g *conflictGuard) hold(name string) bool {
	g.stageMu.Lock()
	defer g.stageMu.Unlock()
	if _, ok := g.staged[name]; ok {
		return true
	}
	return g.merged[name]
}

func (g *conflictGuard) admit(name string) {
	g.stageMu.Lock()
	defer g.stageMu.Unlock()
	g.merged[name] = true
}

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
	g.absorb(inFlight)
	listings := map[string]map[string]bool{}
	hashes := 0
	baselined := map[string]*pendingSave{}
	for _, e := range queue {
		if e.Name == "" || !inFlight[e.Name] {
			continue
		}
		if save, ok := g.seen[e.Name]; ok {
			if err := g.refreshSave(e.Name, save); err != nil {
				return res, err
			}
			if save.reason != "" && !save.reported {
				res.Skipped = append(res.Skipped, ConflictSkip{Remote: e.Name, Reason: save.reason})
				save.reported = true
			}
			continue
		}
		if g.hasSightLoop {
			// The sight loop reads the queue on its own tick, so this save is recorded there (issue #1146).
			continue
		}
		if hashes >= conflictSightMax {
			res.Behind++
			continue
		}
		hashes++
		save, skip, err := g.sight(ctx, b, e.Name, listings)
		if errors.Is(err, errNoCacheFile) {
			hashes--
			continue
		}
		if err != nil {
			return res, err
		}
		g.seen[e.Name] = save
		g.admit(e.Name)
		g.order = append(g.order, e.Name)
		if skip.Reason != "" {
			res.Skipped = append(res.Skipped, skip)
		}
		if save.previous != "" {
			baselined[e.Name] = save
		}
	}
	g.forgetBaselinesReadAfterUpload(ctx, b, baselined)

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
	g.stageMu.Lock()
	for _, name := range finished {
		delete(g.seen, name)
		delete(g.merged, name)
	}
	g.stageMu.Unlock()
	if len(res.Claimed) > 0 {
		if err := b.reachable(ctx); err != nil {
			return res, nil
		}
		if err := b.refresh(ctx, false); err != nil {
			return res, fmt.Errorf("conflict: refresh after claiming: %w", err)
		}
	}
	return res, nil
}

func (g *conflictGuard) forgetBaselinesReadAfterUpload(ctx context.Context, b conflictBackend, saves map[string]*pendingSave) {
	if len(saves) == 0 {
		return
	}
	stillQueued := map[string]bool{}
	if queue, err := b.queue(ctx); err == nil {
		for _, e := range queue {
			stillQueued[e.Name] = true
		}
	}
	for name, save := range saves {
		if !stillQueued[name] {
			save.previous = ""
		}
	}
}

// stage is the sighting half: it reads the upload queue and records every save no decide pass holds yet, with the save's own bytes and the version storage carried before the save lands. It runs on its own tick so a save entering the queue is recorded inside the write-back delay even while the decide loop sits behind a large claim copy or a wave of slow hash reads (issue #1146).
func (g *conflictGuard) stage(ctx context.Context, b conflictBackend) (ConflictResult, error) {
	var res ConflictResult
	queue, err := b.queue(ctx)
	if err != nil {
		return res, fmt.Errorf("conflict: read the upload queue: %w", err)
	}
	seenOnce := map[string]bool{}
	for _, e := range queue {
		if e.Name == "" || seenOnce[e.Name] {
			continue
		}
		seenOnce[e.Name] = true
	}
	res.Watched = len(seenOnce)

	listings := map[string]map[string]bool{}
	hashes := 0
	var skipped []ConflictSkip
	var incoming []string
	saves := map[string]*pendingSave{}
	for _, e := range queue {
		if e.Name == "" || !seenOnce[e.Name] {
			continue
		}
		seenOnce[e.Name] = false
		if g.hold(e.Name) {
			continue
		}
		res.Behind++
		if hashes >= conflictSightMax {
			continue
		}
		hashes++
		save, skip, err := g.sight(ctx, b, e.Name, listings)
		if errors.Is(err, errNoCacheFile) {
			hashes--
			continue
		}
		if err != nil {
			return res, err
		}
		if skip.Reason != "" {
			skipped = append(skipped, skip)
		}
		saves[e.Name] = save
		incoming = append(incoming, e.Name)
	}
	// A listing read that outlasted the upload leaves a stale baseline behind: the baseline would then be the save's own uploaded bytes, and the guard would wave a foreign overwrite through as this device's own save. The same rule the decide pass applies (forgetBaselinesReadAfterUpload) applies here.
	g.forgetBaselinesReadAfterUpload(ctx, b, saves)
	g.stageMu.Lock()
	for _, name := range incoming {
		if g.merged[name] {
			// The decide pass sighted this save itself while we were sighting: its own record is already polling, so ours would be redundant.
			continue
		}
		g.staged[name] = saves[name]
		g.stagedOrder = append(g.stagedOrder, name)
		res.Behind--
	}
	g.stageMu.Unlock()
	res.Skipped = append(res.Skipped, skipped...)
	return res, nil
}

// refreshSave re-reads a watched save whose bytes on this machine changed, so the copy the guard keeps later holds the bytes the upload will carry.
func (g *conflictGuard) refreshSave(name string, save *pendingSave) error {
	if save.reason != "" || !g.mountChanged(name, save) {
		return nil
	}
	if save.byFingerprint {
		info, err := g.mountStat(name)
		if err != nil {
			save.reason = fmt.Sprintf("the save is not in the drive any more: %v", err)
			return nil
		}
		if reason := statReason(info); reason != "" && info.size <= conflictProtectMax {
			save.reason = reason
			return nil
		}
		if info.size > conflictProtectMax {
			save.stat = info
			save.hash = fmt.Sprintf("size:%d:mtime:%d", info.size, info.modTime.UnixNano())
			return nil
		}
		save.byFingerprint = false
	}
	reason, err := g.rehash(name, save)
	if err != nil {
		return err
	}
	if reason != "" {
		save.reason = reason
	}
	return nil
}

// absorb merges the staged saves into this pass's watch list. A staged save that left the queue before this pass read it drops its baseline: the same rule forgetBaselinesReadAfterUpload applies when a listing read outlasts the upload, and a stale baseline can only be the save's own uploaded bytes, which would let the guard wave a foreign overwrite through as this device's own save (issue #1146).
func (g *conflictGuard) absorb(inFlight map[string]bool) {
	g.stageMu.Lock()
	incoming, order := g.staged, g.stagedOrder
	g.staged, g.stagedOrder = map[string]*pendingSave{}, nil
	g.stageMu.Unlock()
	for _, name := range order {
		if _, ok := g.seen[name]; ok {
			// The decide pass sighted this save itself before our staged record arrived: its own record is already polling, so ours is redundant.
			continue
		}
		g.admit(name)
		save := incoming[name]
		g.seen[name] = save
		g.order = append(g.order, name)
		if !inFlight[name] {
			// The save left the queue before this pass read it: its baseline is its own uploaded bytes now, and a stale baseline would wave a foreign overwrite through.
			save.previous = ""
		}
	}
}

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

func (g *conflictGuard) sight(ctx context.Context, b conflictBackend, name string, listings map[string]map[string]bool) (*pendingSave, ConflictSkip, error) {
	info, err := g.mountStat(name)
	if err != nil {
		skip := fmt.Sprintf("the save is not in the drive any more: %v", err)
		return &pendingSave{reason: skip, reported: true}, ConflictSkip{Remote: name, Reason: skip}, nil
	}
	if !info.regular {
		reason := fmt.Sprintf("it is a %s, not a regular file", info.modeType)
		return &pendingSave{reason: reason, reported: true}, ConflictSkip{Remote: name, Reason: reason}, nil
	}
	if info.size > conflictProtectMax {
		fp := fmt.Sprintf("size:%d:mtime:%d", info.size, info.modTime.UnixNano())
		save := &pendingSave{hash: fp, stat: info, byFingerprint: true}
		save.previous = g.previousHash(ctx, b, name, listings)
		return save, ConflictSkip{}, nil
	}
	hash, err := g.hashMountFile(name)
	if errors.Is(err, errProtectTooLarge) {
		skip := fmt.Sprintf("the save grew past the %d-byte protection cap while it was hashed", conflictProtectMax)
		return &pendingSave{reason: skip, reported: true}, ConflictSkip{Remote: name, Reason: skip}, nil
	}
	if err != nil {
		return nil, ConflictSkip{}, fmt.Errorf("conflict: read %s from the mount: %w", name, err)
	}
	save := &pendingSave{hash: hash, stat: info}
	save.previous = g.previousHash(ctx, b, name, listings)
	return save, ConflictSkip{}, nil
}

func (g *conflictGuard) decide(ctx context.Context, b conflictBackend, name string, save *pendingSave) (drop bool, skip *ConflictSkip, copy *ConflictCopy, err error) {
	if !save.byFingerprint && g.mountChanged(name, save) {
		reason, err := g.rehash(name, save)
		if err != nil {
			return false, nil, nil, err
		}
		if reason != "" {
			return true, &ConflictSkip{Remote: name, Reason: reason}, nil, nil
		}
	}
	save.polls++
	landed, err := b.remoteHash(ctx, name)
	if err != nil {
		return g.hashFailed(name, save, "the remote hash for this file could not be read")
	}
	switch {
	case save.byFingerprint && landed != "" && landed != save.previous:
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
				g.rememberSynced(name, landed)
				return true, nil, nil, nil
			}
			return false, nil, nil, nil
		}
		g.rememberSynced(name, landed)
		return true, &ConflictSkip{
			Remote: name,
			Reason: "another version landed on a file too large to keep a copy of",
		}, nil, nil
	case landed == save.hash:
		save.winPolls++
		if save.winPolls >= conflictWinPolls {
			g.rememberSynced(name, landed)
			return true, nil, nil, nil
		}
		return false, nil, nil, nil
	case landed == "" || landed == save.previous:
		if save.polls >= conflictClaimPolls {
			return true, nil, nil, nil
		}
		return false, nil, nil, nil
	default:
		if save.byFingerprint {
			g.rememberSynced(name, landed)
			return true, &ConflictSkip{
				Remote: name,
				Reason: "the file is compared by size and time and a copy could not be kept",
			}, nil, nil
		}
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
		claim, err := g.claim(ctx, b, name, save)
		if errors.Is(err, errClaimSourceChanged) {
			return true, &ConflictSkip{Remote: name, Reason: conflictSkipSourceChanged}, nil, nil
		}
		if err != nil {
			return false, nil, nil, err
		}
		g.rememberSynced(name, landed)
		return true, nil, &claim, nil
	}
}

func (g *conflictGuard) hashFailed(name string, save *pendingSave, reason string) (bool, *ConflictSkip, *ConflictCopy, error) {
	save.hashFails++
	if save.hashFails >= conflictHashFailPolls && !save.reported {
		save.reason = reason
		save.reported = true
		return true, &ConflictSkip{Remote: name, Reason: reason}, nil, nil
	}
	return false, nil, nil, nil
}

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
	return "", nil
}

func (g *conflictGuard) claim(ctx context.Context, b conflictBackend, path string, save *pendingSave) (ConflictCopy, error) {
	for index := 1; ; index++ {
		name, err := freeConflictName(ctx, b, path, g.device, index)
		if err != nil {
			return ConflictCopy{}, fmt.Errorf("conflict: %w", err)
		}
		src := g.sourceFile(path)
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
		srcHash, srcErr := g.hashMountFile(path)
		if srcErr != nil || srcHash != save.hash {
			return ConflictCopy{}, errClaimSourceChanged
		}
		if index >= conflictCopyLimit {
			return ConflictCopy{}, fmt.Errorf("conflict: every conflict name for %s holds another writer's bytes", path)
		}
	}
}

func (g *conflictGuard) mountStat(name string) (mountFileInfo, error) {
	info, err := os.Stat(filepath.Join(g.mountDir, filepath.FromSlash(name)))
	if err != nil {
		return mountFileInfo{}, err
	}
	return mountFileInfo{modTime: info.ModTime(), size: info.Size(), regular: info.Mode().IsRegular(), modeType: info.Mode().Type()}, nil
}

type mountFileInfo struct {
	modTime  time.Time
	size     int64
	regular  bool
	modeType os.FileMode
}

func statReason(info mountFileInfo) string {
	if !info.regular {
		return fmt.Sprintf("it is a %s, not a regular file", info.modeType)
	}
	if info.size > conflictProtectMax {
		return fmt.Sprintf("%d bytes is over the %d-byte protection cap", info.size, conflictProtectMax)
	}
	return ""
}

func (g *conflictGuard) mountChanged(name string, save *pendingSave) bool {
	info, err := g.mountStat(name)
	if err != nil || info.modTime.IsZero() || save.stat.modTime.IsZero() {
		return false
	}
	return !info.modTime.Equal(save.stat.modTime) || info.size != save.stat.size
}

func (g *conflictGuard) previousHash(ctx context.Context, b conflictBackend, name string, listings map[string]map[string]bool) string {
	if previous := g.lastSynced(name); previous != "" {
		return previous
	}
	present, err := g.parentListing(ctx, b, parentDir(name), listings)
	if err != nil {
		hash, herr := b.remoteHash(ctx, name)
		if herr != nil {
			return ""
		}
		return hash
	}
	if !present[remoteBase(name)] {
		return ""
	}
	hash, err := b.remoteHash(ctx, name)
	if err != nil {
		return ""
	}
	return hash
}

// lastSynced reads the hash this device last confirmed as its own upload at name; the decide half writes it through rememberSynced and the sight half reads it here as a baseline.
func (g *conflictGuard) lastSynced(name string) string {
	g.syncedMu.Lock()
	defer g.syncedMu.Unlock()
	return g.synced[name]
}

func (g *conflictGuard) rememberSynced(name, hash string) {
	g.syncedMu.Lock()
	defer g.syncedMu.Unlock()
	g.synced[name] = hash
}

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

func parentDir(name string) string {
	if i := strings.LastIndex(name, "/"); i >= 0 {
		return name[:i]
	}
	return ""
}

func dirLabel(dir string) string {
	if dir == "" {
		return "the top of the drive"
	}
	return dir
}

func (g *conflictGuard) sourceFile(name string) string {
	if p := g.cacheFile(name); p != "" {
		return p
	}
	if g.cacheDir != "" {
		return ""
	}
	return filepath.Join(g.mountDir, filepath.FromSlash(name))
}

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
	// nosemgrep: go.lang.security.audit.crypto.use_of_weak_crypto.use-of-md5
	h := md5.New()
	read, err := io.Copy(h, io.LimitReader(in, conflictProtectMax+1))
	if err != nil {
		return "", err
	}
	if read > conflictProtectMax {
		return "", fmt.Errorf("%w: %s", errProtectTooLarge, path)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

var errNoCacheFile = errors.New("no VFS cache file")

var errProtectTooLarge = errors.New("the save grew past the protection cap while it was hashed")

const conflictSkipSourceChanged = "the save's bytes are no longer the ones this device saved, so they cannot be kept"

var errClaimSourceChanged = errors.New(conflictSkipSourceChanged)

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

// ConflictGuardStatePath is where the running guard reports how far behind it is: one small file inside this device's own config folder, written every pass, so `drive status` can name a backlog without talking to the mount.
func ConflictGuardStatePath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "conflict-guard.json")
}

type conflictGuardState struct {
	Behind    int       `json:"behind"`
	UpdatedAt time.Time `json:"updatedAt"`
}

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

// RunConflictLoop is the guard, running inside the mount process for as long as the mount does.
func RunConflictLoop(ctx context.Context, device, mountDir, cacheDir, fs, statePath string, c conflictBackend) <-chan error {
	msgs := make(chan error, 64)
	go func() {
		defer close(msgs)
		guard := newConflictGuard(device, mountDir)
		guard.cacheDir, guard.fs = cacheDir, fs
		guard.SightLoop()
		var reportMu sync.Mutex
		lastReport := make(map[string]time.Time)
		report := func(format string, args ...any) {
			line := fmt.Sprintf(format, args...)
			reportMu.Lock()
			if time.Since(lastReport[line]) < conflictReportEvery {
				reportMu.Unlock()
				return
			}
			lastReport[line] = time.Now()
			reportMu.Unlock()
			select {
			case msgs <- fmt.Errorf("%s", line):
			default:
			}
		}
		speak := func(res ConflictResult) {
			for _, claim := range res.Claimed {
				report("kept the save that landed first: %s (the other device saved %s)",
					claim.Remote, claim.LosingPath)
			}
			for _, skip := range res.Skipped {
				report("could not protect %s: %s", skip.Remote, skip.Reason)
			}
		}
		// The decide loop polls the remote for the saves it watched and copies the conflict candidates (issue #1146). Its passes can run past the write-back delay - a large claim copy, a wave of hash reads or slow storage - so it is decoupled from the sight loop below, and its bundle of remote work never delays the next queue read.
		var decides sync.WaitGroup
		decides.Add(1)
		go func() {
			defer decides.Done()
			ticker := time.NewTicker(conflictInterval)
			defer ticker.Stop()
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
					continue
				}
				speak(res)
			}
		}()
		// The sight loop reads the upload queue every conflictInterval itself, so a save that lands within the write-back delay is recorded even while the decide loop is deep in its own work (issue #1146).
		ticker := time.NewTicker(conflictInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				decides.Wait()
				return
			case <-ticker.C:
			}
			passCtx, cancel := context.WithTimeout(ctx, conflictContextTimeout)
			res, err := guard.stage(passCtx, c)
			cancel()
			if err != nil {
				report("%v", err)
				continue
			}
			if err := writeConflictGuardState(statePath, res.Behind, time.Now()); err != nil {
				report("conflict: write the guard state: %v", err)
			}
			speak(res)
		}
	}()
	return msgs
}
