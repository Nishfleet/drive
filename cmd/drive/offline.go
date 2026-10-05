package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// drive offline / drive online: keep a file or a whole folder on this computer
// so it opens with no internet (drive issue #115).
//
// What the stock rclone route is, because the issue asks for it to be searched
// for first rather than invented. Read on rclone v1.75.1, this is the whole
// search:
//
//   - rclone's VFS file cache, `mount --help` "Virtual File System (VFS)" and
//     `--vfs-cache-mode full`: a file opened through the mount is read into
//     `--cache-dir` on disk, and from then on rclone serves that open from the
//     disk. `--vfs-write-back` (5s on our mount) queues a save and uploads it.
//     So "opens and saves with no internet" is already the mount's promise; no
//     second reader is needed for it.
//   - rclone's eviction rule, same help text: "When
//     `--vfs-cache-max-size` ... is exceeded, rclone will attempt to evict the
//     least accessed files from the cache first. rclone will start with files
//     that haven't been accessed for the longest." The code behind that is
//     vfs/vfscache/item.go `Items.Less`, which compares `info.ATime`, and
//     cache.go `purgeClean`, which resets clean items in that order until the
//     cache is back under `--vfs-cache-max-size`.
//   - rclone's remote control (`rclone rc --loopback rc/list`), which is what
//     the fill loop in fill_run.go already uses: vfs/stats, vfs/refresh,
//     vfs/queue, vfs/forget, vfs/poll-interval. There is no vfs/pin,
//     vfs/pin-clear or vfs/offline on that list.
//
// So rclone has no pin. What it does have is the access time its own eviction
// sorts on, and this file uses exactly that: a kept-offline file is re-read on
// every fill pass (fill_run.go `fillTargets.read`), so it is the most recently
// used item in the cache and rclone's own rule evicts the rest of the drive
// first. Measured, not assumed: the proof in offline_e2e_test.go drives the
// cache to 3.5x `--vfs-cache-max-size` with six other files and the kept
// file is still whole on disk.
//
// What is NOT hand-written here and must not be: a sync engine. Nothing in
// this file opens a connection to storage, keeps its own transfer queue or
// decides what a save means. Every byte read is read through the mount, which
// is a read rclone does; every byte written is written through the mount,
// which rclone queues and uploads. The one file this product owns is the list
// of paths below, and it holds no bytes.

// OfflineIndex is what this computer keeps offline: paths relative to the
// mount root, in the order they were asked for. It is the only record of the
// promise — the bytes live in rclone's VFS cache and nowhere else, so a path
// removed here simply stops being refreshed and is evicted on rclone's own
// clock, which is what `drive online` promises.
//
// A file this product did not write and cannot parse is an error, never an
// empty set: a list that quietly reads as "nothing is kept offline" would tell
// a person their offline folder was never kept.
type OfflineIndex struct {
	Paths []string `json:"paths"`
}

// Empty reports whether nothing is kept offline, which is the answer a person
// gets on a fresh install and the state `drive online` with no argument leaves
// the machine in.
func (o OfflineIndex) Empty() bool { return len(o.Paths) == 0 }

// Has reports whether rel is in the set. Paths are stored already normalised by
// OfflineRelative, so this is an exact match on the form the file holds.
func (o OfflineIndex) Has(rel string) bool {
	for _, p := range o.Paths {
		if p == rel {
			return true
		}
	}
	return false
}

// Add puts rel in the set and reports whether it was not there already. Keeping
// the order and dropping a duplicate is what makes `drive offline` twice in a
// row say so rather than fill the file twice.
func (o *OfflineIndex) Add(rel string) bool {
	if o.Has(rel) {
		return false
	}
	o.Paths = append(o.Paths, rel)
	return true
}

// Remove takes rel out of the set. A path that is not there is not an error:
// `drive online /Photos` after `drive online /Photos` is the state the person
// asked for, twice.
func (o *OfflineIndex) Remove(rel string) bool {
	for i, p := range o.Paths {
		if p == rel {
			o.Paths = append(o.Paths[:i], o.Paths[i+1:]...)
			return true
		}
	}
	return false
}

// OfflineIndexPath is where the list of kept-offline paths lives. It is beside
// the rclone config the CLI already writes, in the same config directory, so
// `drive status` and `drive mount --foreground` read it from a path this
// product already owns and there is no second location to keep in step.
func OfflineIndexPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "offline.json")
}

// LoadOffline reads the kept-offline list. An absent file is an empty set,
// which is the true answer on a machine that has never kept anything offline
// and on one that has run `drive online` to the end. Any other read or parse
// failure is returned with its cause: a list that cannot be read must not be
// printed as "nothing is kept offline", because that is how a person finds out
// their copy was never there.
func LoadOffline(home string) (OfflineIndex, error) {
	raw, err := os.ReadFile(OfflineIndexPath(home))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return OfflineIndex{}, nil
		}
		return OfflineIndex{}, fmt.Errorf("read %s: %w", OfflineIndexPath(home), err)
	}
	var idx OfflineIndex
	if err := json.Unmarshal(raw, &idx); err != nil {
		return OfflineIndex{}, fmt.Errorf("parse %s: %w", OfflineIndexPath(home), err)
	}
	return idx, nil
}

// SaveOffline writes the list back atomically, so a machine that loses power
// mid-write keeps the list it had rather than an empty one. Mode 0600 beside
// the rclone config: the list itself is only paths, and the file is not a
// secret, but it is one directory away from one that is.
func SaveOffline(home string, idx OfflineIndex) error {
	raw, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return fmt.Errorf("render the kept-offline list: %w", err)
	}
	if err := WriteFileAtomic(OfflineIndexPath(home), append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return nil
}

// OfflineRelative normalises what a person typed into a path relative to the
// mount root, or refuses it.
//
// A path is refused when it walks out of the drive. `../elsewhere` or an
// absolute path outside the mount would make the fill read a directory that is
// not this drive and print its bytes in `drive status` as kept offline, so the
// walk never starts: the only tree this file can name is the mount's.
//
// The result is always slash-separated and has no trailing slash, so
// `/Photos/` and `Photos` are one entry and one line of `drive status`.
func OfflineRelative(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("no path given")
	}
	// A Windows-style separator is accepted so a path pasted from Explorer
	// means the same thing; it is normalised to slash before anything is
	// joined, so the stored value is one spelling on every platform.
	slashed := strings.TrimPrefix(strings.ReplaceAll(trimmed, `\`, "/"), "/")
	if slashed == "" {
		return "", fmt.Errorf("%q names the drive root; keep the file or folder, not everything", raw)
	}
	cleaned := path.Clean(slashed)
	if cleaned == "." {
		return "", fmt.Errorf("%q names the drive root; keep the file or folder, not everything", raw)
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("%q walks out of the drive", raw)
	}
	return cleaned, nil
}

// OfflineUsage is one kept-offline path and what it costs on disk: how many
// files it holds and how many bytes they are. It is measured through the mount,
// which is a directory listing and a stat per file — no file bytes — so the
// number is the same with and without a network and is the number the bytes
// will occupy in rclone's cache once they are there.
type OfflineUsage struct {
	Path  string
	Files int
	Bytes int64
}

// MeasureOffline adds up what each kept path holds. A path that is not on the
// drive any more is reported as zero files and no error: a file deleted on the
// other machine is not a broken list, and the refresh pass simply has nothing
// to read for it. Anything else — an unreadable mount, a permission error — is
// returned, because a size this product invented would be the number a person
// plans a flight around.
func MeasureOffline(mountDir string, paths []string) ([]OfflineUsage, error) {
	out := make([]OfflineUsage, 0, len(paths))
	for _, rel := range paths {
		full := filepath.Join(mountDir, filepath.FromSlash(rel))
		u := OfflineUsage{Path: rel}
		err := filepath.WalkDir(full, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				return err
			}
			if d.IsDir() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				return err
			}
			u.Files++
			u.Bytes += info.Size()
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("measure %s: %w", rel, err)
		}
		out = append(out, u)
	}
	return out, nil
}

// TotalOffline sums each path's own files and bytes. Nested entries can
// overlap; UniqueOffline is the number the cap and the status total use.
func TotalOffline(usage []OfflineUsage) (files int, bytes int64) {
	for _, u := range usage {
		files += u.Files
		bytes += u.Bytes
	}
	return files, bytes
}

// UniqueOffline counts each file once, even when a folder and a file inside
// it are both on the kept-offline list, so the cap and the status total are
// the disk the set actually uses.
func UniqueOffline(mountDir string, paths []string) (int, int64, error) {
	seen := make(map[string]struct{})
	var files int
	var bytes int64
	for _, rel := range paths {
		full := filepath.Join(mountDir, filepath.FromSlash(rel))
		err := filepath.WalkDir(full, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				return err
			}
			if d.IsDir() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				return err
			}
			abs, err := filepath.Abs(p)
			if err != nil {
				abs = p
			}
			if _, ok := seen[abs]; ok {
				return nil
			}
			seen[abs] = struct{}{}
			files++
			bytes += info.Size()
			return nil
		})
		if err != nil {
			return 0, 0, fmt.Errorf("measure %s: %w", rel, err)
		}
	}
	return files, bytes, nil
}

// overOfflineCap reports whether a kept-offline set cannot fit inside the
// mount's cache limit. A zero or negative cap is "no limit", which is rclone's
// own `--vfs-cache-max-size` off.
func overOfflineCap(bytes, cap int64) bool {
	return cap > 0 && bytes > cap
}

// offlineCapError is the refusal `drive offline` prints when the set cannot
// fit. The cache limit is the mount's `--vfs-cache-max-size`; there is no
// second cache command.
func offlineCapError(bytes, cap int64) error {
	return fmt.Errorf("keeping this offline needs %s and the cache limit is %s; raise it with `drive cache --max` or keep less",
		FormatBytes(bytes), FormatBytes(cap))
}

// offlineMountDir is the folder `drive offline` reads through: the live mount
// point. On Windows that is the drive letter, not ~/Drive.
func offlineMountDir(home string) string {
	goos := CurrentGOOS()
	on, err := Mounted(goos, home)
	if err == nil && on && goos == "windows" {
		letter, err := windowsMountLetter()
		if err == nil {
			return windowsVolumeRoot(letter)
		}
	}
	return DefaultMountDir(home)
}

// OfflineCapBytes is the limit a kept-offline set has to fit inside: the same
// `--vfs-cache-max-size` the mount runs with, which is the value `drive cache
// --max` wrote or the shipped 20G default. There is no other cache to keep a
// file in — see the top of this file — so this is the number, and the reason
// `drive offline` refuses a set that cannot fit.
func OfflineCapBytes(home string) (int64, error) {
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		return 0, err
	}
	return parseSizeSuffix(maxSize)
}

// KeepOffline downloads a full copy of rel into rclone's VFS cache and reports
// how many bytes it read. The read is through the mount, byte for byte the read
// an app makes when it opens the file, so the copy lands in the cache
// `--vfs-cache-max-size` already bounds and nowhere else — there is no
// directory this product writes file bytes into.
//
// A file that is already whole in the cache is read again rather than skipped:
// reading it is what marks it as the most recently used item, which is
// rclone's own eviction order (see the top of this file), and the read costs a
// disk read because rclone serves it from disk.
func KeepOffline(mountDir, rel string) (int64, error) {
	full := filepath.Join(mountDir, filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", rel, err)
	}
	if !info.IsDir() {
		return fillReadFile(full)
	}
	var total int64
	err = filepath.WalkDir(full, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		n, err := fillReadFile(p)
		if err != nil {
			return err
		}
		total += n
		return nil
	})
	if err != nil {
		return total, err
	}
	return total, nil
}

// runOffline is `drive offline`: keep a file or a folder on this computer.
//
// The order is the order of the promise. Each path is measured first, and a set
// that cannot fit inside the cache cap is refused before a byte moves, because
// the promise cannot be kept for it: rclone evicts over the cap on its own
// poll and there is nowhere else for those bytes to live. Only then is the
// list written and the copy downloaded, so a refused request leaves the
// machine exactly as it was.
func runOffline(args []string) error {
	fs := flag.NewFlagSet("offline", flag.ContinueOnError)
	list := fs.Bool("list", false, "list what is kept offline and how much disk it uses")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	mountDir := offlineMountDir(common.home)
	if *list {
		return printOffline(mountDir, common.home)
	}
	if fs.NArg() == 0 {
		return errors.New("drive offline: name the file or folder to keep on this computer, or pass --list")
	}
	rels := make([]string, 0, fs.NArg())
	for _, raw := range fs.Args() {
		rel, err := OfflineRelative(raw)
		if err != nil {
			return fmt.Errorf("drive offline: %w", err)
		}
		rels = append(rels, rel)
	}
	idx, err := LoadOffline(common.home)
	if err != nil {
		return err
	}
	would := OfflineIndex{Paths: append([]string(nil), idx.Paths...)}
	for _, rel := range rels {
		would.Add(rel)
	}
	_, bytes, err := UniqueOffline(mountDir, would.Paths)
	if err != nil {
		return err
	}
	capBytes, err := OfflineCapBytes(common.home)
	if err != nil {
		return err
	}
	if overOfflineCap(bytes, capBytes) {
		return offlineCapError(bytes, capBytes)
	}
	added := make([]string, 0, len(rels))
	already := make(map[string]bool, len(rels))
	for _, rel := range rels {
		if idx.Add(rel) {
			added = append(added, rel)
		} else {
			already[rel] = true
		}
	}
	if len(added) > 0 {
		if err := SaveOffline(common.home, idx); err != nil {
			return err
		}
	}
	var read int64
	for _, rel := range rels {
		n, err := KeepOffline(mountDir, rel)
		read += n
		if err != nil {
			return err
		}
	}
	usage, err := MeasureOffline(mountDir, rels)
	if err != nil {
		return err
	}
	for _, u := range usage {
		note := ""
		if already[u.Path] {
			note = " (already kept offline)"
		}
		fmt.Printf("kept offline: %s (%s, %d %s)%s\n",
			u.Path, FormatBytes(u.Bytes), u.Files, pluralFiles(u.Files), note)
	}
	fmt.Printf("offline: %d %s kept, %s read, %s of the %s cache limit\n",
		len(idx.Paths), pluralPaths(len(idx.Paths)), FormatBytes(read), FormatBytes(bytes), FormatBytes(capBytes))
	return nil
}

// runOnline is `drive online`: give the disk back. With no argument every kept
// path goes; with arguments only those. The bytes stay where rclone put them
// and leave on rclone's own clock, which is the honest promise: this releases
// the hold, it does not delete anything.
func runOnline(args []string) error {
	fs := flag.NewFlagSet("online", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	idx, err := LoadOffline(common.home)
	if err != nil {
		return err
	}
	if fs.NArg() == 0 {
		if idx.Empty() {
			fmt.Println("offline: none")
			return nil
		}
		for _, rel := range idx.Paths {
			fmt.Printf("online again: %s\n", rel)
		}
		return SaveOffline(common.home, OfflineIndex{})
	}
	for _, raw := range fs.Args() {
		rel, err := OfflineRelative(raw)
		if err != nil {
			return fmt.Errorf("drive online: %w", err)
		}
		if idx.Remove(rel) {
			fmt.Printf("online again: %s\n", rel)
		} else {
			fmt.Printf("not kept offline: %s\n", rel)
		}
	}
	return SaveOffline(common.home, idx)
}

// printOffline is the `--list` half of `drive offline` and the same lines
// `drive status` shows, so the number a person reads in one place is the
// number they read in the other.
func printOffline(mountDir, home string) error {
	idx, err := LoadOffline(home)
	if err != nil {
		return err
	}
	if idx.Empty() {
		fmt.Println("offline: none")
		return nil
	}
	usage, err := MeasureOffline(mountDir, idx.Paths)
	if err != nil {
		return err
	}
	_, bytes, err := UniqueOffline(mountDir, idx.Paths)
	if err != nil {
		return err
	}
	printOfflineUsage(home, usage, bytes)
	return nil
}

// printOfflineUsage writes the kept-offline block: one line per path with its
// own files and bytes, then the one line that answers "how much of my disk is
// this". Shared with `drive status` so the two cannot drift. bytes is
// UniqueOffline's count, so a nested folder is not added twice.
func printOfflineUsage(home string, usage []OfflineUsage, bytes int64) {
	capBytes, err := OfflineCapBytes(home)
	if err != nil {
		fmt.Printf("offline: %s kept (the cache limit is unreadable: %v)\n", pluralPaths(len(usage)), err)
		return
	}
	for _, u := range usage {
		fmt.Printf("  %s  %s  %d %s\n", u.Path, FormatBytes(u.Bytes), u.Files, pluralFiles(u.Files))
	}
	fmt.Printf("offline: %d %s kept, %s of the %s cache limit\n",
		len(usage), pluralPaths(len(usage)), FormatBytes(bytes), FormatBytes(capBytes))
}

// pluralPaths keeps the count of kept paths in one grammar across `drive
// offline`, `drive online` and `drive status`, so the CLI never says "1 paths".
// It is the same shape as pluralFiles in branch.go, one noun over.
func pluralPaths(n int) string {
	if n == 1 {
		return "path"
	}
	return "paths"
}
