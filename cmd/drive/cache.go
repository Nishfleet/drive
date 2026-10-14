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

const cacheMaxFlag = "max"

func runCache(args []string) error {
	fs := flag.NewFlagSet("cache", flag.ContinueOnError)
	maxSize := fs.String(cacheMaxFlag, "", "cache limit: a size like 5G or 500M")
	clear := fs.Bool("clear", false, "empty the cache; files waiting to upload stay")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
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

var mountOn = Mounted

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

func printCache(home string) error {
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		return err
	}
	return printCacheAt(home, maxSize)
}

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

// CacheUse measures the directory rclone itself reports the cache at, by the same walk the background fill uses for its cap guard, so the size `drive cache` prints and the size the fill enforces the cap against are one walk.
func CacheUse(cacheDir string) (int64, int, error) {
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

// ClearCache empties the cache except the files rclone still has to upload and the files this computer keeps offline (issue #115).
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
