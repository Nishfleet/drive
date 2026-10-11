package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// `drive cache` (issue #112): the three things a person can ask about the disk
// their drive uses, and nothing else.
//
// The cache is rclone's own VFS cache, and this command is a view of it rather
// than a second one: the size is measured where rclone stores the bytes, the
// limit is rclone's own --vfs-cache-max-size read back off the mount's live
// options, and the amount of disk is the walk FillRun already makes for its own
// cap guard. No counter of our own, no second cache, no daemon: the number
// `drive cache` prints and the number rclone enforces are the same number.
//
//   - `drive cache`            what is on disk now, and the limit it is held to
//   - `drive cache --max 5G`   change the limit (and re-mount so it takes now)
//   - `drive cache --clear`    empty the cache, leaving the uploads still waiting
//                              and the files kept offline (issue #115)
//
// A hard cap is always on: the mount carries --vfs-cache-max-size (the person's
// number, 20G by default) and --vfs-cache-min-free-space 1G, so the cache can
// only ever be smaller than the smaller of those two and can never take the
// disk it lives on to zero free.

// cacheMaxFlag is the flag that changes the limit. The name is the value people
// see: `drive cache --max 5G`. It is not --limit and not --size, so a person
// who read the docs page reads the same word the flag uses.
const cacheMaxFlag = "max"

// runCache is the entry point main.go dispatches to.
func runCache(args []string) error {
	fs := flag.NewFlagSet("cache", flag.ContinueOnError)
	maxSize := fs.String(cacheMaxFlag, "", "cache limit: a size like 5G or 500M")
	clear := fs.Bool("clear", false, "empty the cache; files waiting to upload stay")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	// Exactly one operation per run, so a person who types two cannot get
	// half of one of them. --max and --clear together would otherwise leave
	// the question of which ran first.
	ops := 0
	for _, set := range []bool{*maxSize != "", *clear} {
		if set {
			ops++
		}
	}
	if ops > 1 {
		return fmt.Errorf("one thing at a time: run `drive cache --max <size>` or `drive cache --clear`, not both")
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q; `drive cache` takes --max and --clear only", fs.Arg(0))
	}
	home := common.home
	switch {
	case *clear:
		return clearCache(home, common.rclone)
	case *maxSize != "":
		return setCacheMax(home, *maxSize, common.rclone)
	default:
		return printCache(home)
	}
}

// setCacheMax writes the new limit and re-mounts so it is in force when the
// command returns, rather than at the next login. A limit that only applies
// after a restart is a limit the person has to know about: they typed 5G,
// they expect the cache to be 5G now.
func setCacheMax(home, maxSize, rclone string) error {
	if err := SaveCacheMax(home, maxSize); err != nil {
		return err
	}
	effective, err := ResolveCacheMax(home)
	if err != nil {
		return err
	}
	on, err := Mounted(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	if !on {
		fmt.Printf("cache limit set to %s; it applies the next time the drive mounts\n", effective)
		return nil
	}
	// The same secret sources `drive mount` uses, in the same order, and the
	// same restart `drive cap` performs when a key is swapped. A restart keeps
	// every file still waiting to upload: RestartMount deletes nothing, and
	// rclone's own queue lives in the cache on disk.
	rcloneBin, err := ResolveRclone(rclone)
	if err != nil {
		return err
	}
	secretKey, err := ReadSecretKey(RcloneConfigPath(home), false, os.Stdin)
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	cfg, err := LoadStorageConfig("", "", "", "", "", secretKey, storageFromDisk(home))
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	if err := RestartMount(CurrentGOOS(), home, rcloneBin, cfg); err != nil {
		return fmt.Errorf("the limit is saved, but restarting the mount failed: %w", err)
	}
	if err := printCacheAt(home, effective); err != nil {
		return err
	}
	fmt.Printf("cache limit set to %s and the mount restarted with it\n", effective)
	return nil
}

// mountOn is the kernel's answer to "is this drive mounted?". Tests replace
// it so a refusal while mounted does not need a real FUSE mount.
var mountOn = Mounted

// clearCache empties the cache while leaving the uploads still waiting and the
// files this computer keeps offline. Dirty metadata is rclone's own queue; the
// offline list is `drive offline`'s promise. Everything else goes.
//
// A live mount is refused: deleting vfs/ bytes under rclone leaves a window
// where a read returns NUL and a save between the two walks is lost.
func clearCache(home, rclone string) error {
	on, err := mountOn(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	if on {
		return fail("cache-clear-mounted")
	}
	idx, err := LoadOffline(home)
	if err != nil {
		return err
	}
	if err := ClearCache(DefaultCacheDir(home), idx.Paths); err != nil {
		return err
	}
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		return err
	}
	kept, err := PendingUploads(DefaultCacheDir(home))
	if err != nil {
		return err
	}
	msg := fmt.Sprintf("cache cleared; %s still on disk for the uploads waiting to go up", FormatBytes(kept.Bytes))
	if !idx.Empty() {
		msg += "; files kept offline stay and count toward the limit"
	}
	fmt.Println(msg)
	return printCacheAt(home, maxSize)
}

// printCache answers `drive cache` with no flags. It never fails on a mount
// that is down or a cache that was never used: both are answers, not errors.
func printCache(home string) error {
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		return err
	}
	return printCacheAt(home, maxSize)
}

// printCacheAt prints the two lines the issue asks for: what is on disk now and
// the limit it is held to. The floor is printed as well, because it is the
// other half of the cap and a person comparing the two numbers can see the
// cache is allowed less than the limit on a nearly-full disk. Kept-offline
// files (issue #115) are named when any exist, because they count toward the
// same limit.
func printCacheAt(home, maxSize string) error {
	used, files, err := CacheUse(DefaultCacheDir(home))
	if err != nil {
		return err
	}
	limit, err := parseSizeSuffix(maxSize)
	if err != nil {
		return fmt.Errorf("the cache limit %q is not a size: %w", maxSize, err)
	}
	fmt.Printf("cache on disk: %s in %d files\n", FormatBytes(used), files)
	fmt.Printf("cache limit: %s", maxSize)
	if floor, err := parseSizeSuffix(vfsCacheMinFreeSpaceValue); err == nil && limit > floor {
		// rclone enforces whichever is smaller, so the honest reading of the
		// limit is the smaller of the two.
		fmt.Printf(", and %s of free space kept on the disk holding it", vfsCacheMinFreeSpaceValue)
	}
	fmt.Println()
	idx, err := LoadOffline(home)
	if err != nil {
		return err
	}
	if !idx.Empty() {
		offBytes, offFiles := cacheOfflineUse(DefaultCacheDir(home), idx.Paths)
		fmt.Printf("kept offline: %s in %d files, counting toward the limit\n", FormatBytes(offBytes), offFiles)
	}
	return nil
}

// CacheUse measures the directory rclone itself reports the cache at, by the
// same walk the background fill uses for its cap guard, so the size `drive
// cache` prints and the size the fill enforces the cap against are one walk.
func CacheUse(cacheDir string) (int64, int, error) {
	// The bytes live under <cache-dir>/vfs/<remote>/...; vfsMeta holds rclone's
	// own metadata for each cached file, and the mount is what wrote both.
	root := filepath.Join(cacheDir, "vfs")
	var (
		total int64
		files int
	)
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		total += info.Size()
		files++
		return nil
	})
	if err != nil {
		return 0, 0, fmt.Errorf("measure the cache at %s: %w", root, err)
	}
	return total, files, nil
}

// cacheRelKeptOffline reports whether a cache-relative path (the key after
// stripping vfs/ or vfsMeta/) is one of the mount-relative paths `drive
// offline` keeps. The cache key is remote + object path
// (`drive/bucket/u/me/Photos/a.jpg`); the offline path is the object path
// (`Photos` or `Photos/a.jpg`). A suffix match, or a `/offline/` directory
// prefix inside the key, is the object path.
func cacheRelKeptOffline(rel string, offline []string) bool {
	rel = filepath.ToSlash(rel)
	for _, p := range offline {
		p = strings.Trim(filepath.ToSlash(p), "/")
		if p == "" {
			continue
		}
		if rel == p || strings.HasSuffix(rel, "/"+p) {
			return true
		}
		if strings.Contains(rel, "/"+p+"/") {
			return true
		}
	}
	return false
}

// cacheOfflineUse is the bytes and files in the VFS cache that belong to the
// kept-offline set, so `drive cache` can say those files count toward the
// limit without a second walk of the mount.
func cacheOfflineUse(cacheDir string, offline []string) (int64, int) {
	if len(offline) == 0 {
		return 0, 0
	}
	root := filepath.Join(cacheDir, "vfs")
	var (
		total int64
		files int
	)
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if !cacheRelKeptOffline(queueKey(cacheDir, p), offline) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		total += info.Size()
		files++
		return nil
	})
	return total, files
}

// ClearCache empties the cache except the files rclone still has to upload
// and the files this computer keeps offline (issue #115).
//
// What survives is decided by rclone's own metadata and the kept-offline list,
// not by a list this command invents: Dirty is true while a cached file has
// not reached the object store, and rclone re-uploads those on the next mount.
// A kept-offline file is the same bytes rclone already holds; deleting it
// would break `drive offline`'s promise. The queue is read before the walk
// starts, so a file rclone begins uploading while this runs is already known.
//
// Two things go for everything else: the bytes under vfs/, and the metadata
// under vfsMeta/ that says the file is there. Both are removed on purpose -
// deleting the bytes and keeping the record would leave rclone believing it
// has a file it does not, so the next open of that file would read a file that
// is not there instead of fetching it again. Dropping the record too is what
// makes the next open a cold read, which is what an emptied cache means.
func ClearCache(cacheDir string, offline []string) error {
	queued := map[string]bool{}
	metaRoot := filepath.Join(cacheDir, "vfsMeta")
	err := filepath.WalkDir(metaRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		key := queueKey(cacheDir, p)
		data, err := os.ReadFile(p)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return fmt.Errorf("read %s: %w", p, err)
		}
		var meta VFSMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			return fmt.Errorf("parse vfs metadata %s: %w", p, err)
		}
		if meta.Dirty || cacheRelKeptOffline(key, offline) {
			queued[key] = true
			return nil
		}
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", p, err)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("read the upload queue before clearing: %w", err)
	}
	vfsRoot := filepath.Join(cacheDir, "vfs")
	err = filepath.WalkDir(vfsRoot, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			return nil
		}
		if queued[queueKey(cacheDir, p)] {
			return nil
		}
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", p, err)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("clear the cache under %s: %w", vfsRoot, err)
	}
	return nil
}

// queueKey maps a path under <cache-dir>/vfs/<remote>/<file> and one under
// <cache-dir>/vfsMeta/<remote>/<file> to the same key, so a metadata file names
// the cached file it belongs to and nothing else decides what survives.
func queueKey(cacheDir, p string) string {
	rel, err := filepath.Rel(cacheDir, p)
	if err != nil {
		return p
	}
	rel = filepath.ToSlash(rel)
	rel = strings.TrimPrefix(rel, "vfsMeta/")
	rel = strings.TrimPrefix(rel, "vfs/")
	return rel
}
