package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// A mount folder that already has local files is refused by rclone, so
// `drive mount` parks them in a sibling folder, mounts, and then moves them
// into the drive so they upload (drive#516).

// renameFile is os.Rename, swapped in tests so a mid-park failure can be
// proven without a second filesystem.
var renameFile = os.Rename

// strayHoldingDir is the sibling prefix a non-empty mount directory's local
// files move into so rclone can mount. rclone refuses a non-empty folder; the
// files are not deleted, and restoreStrayMountFiles copies them into the drive
// once the mount is up so they upload. Each park uses a unique suffix so a
// leftover holding folder cannot overwrite an earlier one.
func strayHoldingDir(mountDir string) string {
	return mountDir + ".drive-local"
}

// parkStrayMountFiles moves every entry out of mountDir into a sibling folder
// and returns that folder and the names moved. An empty directory is a no-op
// unless a leftover holding folder still has files: those come back first so
// a later mount cannot strand them.
func parkStrayMountFiles(mountDir string) (holding string, names []string, err error) {
	if err := reclaimStrayHoldings(mountDir); err != nil {
		return "", nil, err
	}
	entries, err := os.ReadDir(mountDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil, nil
		}
		return "", nil, err
	}
	if len(entries) == 0 {
		return "", nil, nil
	}
	holding, err = os.MkdirTemp(filepath.Dir(mountDir), filepath.Base(mountDir)+".drive-local-*")
	if err != nil {
		return "", nil, fmt.Errorf("create a folder for the local files in %s: %w", mountDir, err)
	}
	for _, e := range entries {
		from := filepath.Join(mountDir, e.Name())
		to := filepath.Join(holding, e.Name())
		if err := renameFile(from, to); err != nil {
			for _, name := range names {
				_ = renameFile(filepath.Join(holding, name), filepath.Join(mountDir, name))
			}
			_ = os.Remove(holding)
			return "", nil, fmt.Errorf("move %s out of the way so the drive can mount: %w", from, err)
		}
		names = append(names, e.Name())
	}
	return holding, names, nil
}

// reclaimStrayHoldings copies leftover .drive-local* folders back into
// mountDir so a park that failed last time cannot hide files beside an empty
// mount folder.
func reclaimStrayHoldings(mountDir string) error {
	matches, err := filepath.Glob(strayHoldingDir(mountDir) + "*")
	if err != nil {
		return err
	}
	for _, dir := range matches {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		if err := restoreStrayMountFiles(dir, mountDir); err != nil {
			return err
		}
	}
	return nil
}

// restoreStrayMountFiles copies parked local files into the (now mounted)
// drive folder so they upload, then removes the holding folder when empty.
func restoreStrayMountFiles(holding, mountDir string) error {
	if holding == "" {
		return nil
	}
	entries, err := os.ReadDir(holding)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var kept []string
	for _, e := range entries {
		from := filepath.Join(holding, e.Name())
		to := filepath.Join(mountDir, e.Name())
		if _, err := os.Lstat(to); err == nil {
			// The drive already has this name. Moving the local copy on
			// top of it would overwrite the drive's version, so it stays.
			kept = append(kept, e.Name())
			continue
		}
		if err := moveIntoDrive(from, to); err != nil {
			return fmt.Errorf("copy %s into the drive: %w", e.Name(), err)
		}
	}
	if len(kept) > 0 {
		return fmt.Errorf("the drive already has %s, so the local copies stay here", strings.Join(kept, ", "))
	}
	_ = os.Remove(holding)
	return nil
}

// moveIntoDrive moves one parked entry into the drive folder. The holding
// folder is on the local disk and a mounted drive is another filesystem, so
// a rename there fails with EXDEV: the entry is copied, then removed.
func moveIntoDrive(from, to string) error {
	err := renameFile(from, to)
	if err == nil || !errors.Is(err, syscall.EXDEV) {
		return err
	}
	if err := copyTree(from, to); err != nil {
		return err
	}
	return os.RemoveAll(from)
}

// copyTree copies a file, a symlink or a whole folder from src to dst.
func copyTree(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dst)
	case info.IsDir():
		if err := os.MkdirAll(dst, info.Mode().Perm()|0o700); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	case info.Mode().IsRegular():
		in, err := os.Open(src)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		if err := out.Close(); err != nil {
			return err
		}
		return os.Chtimes(dst, info.ModTime(), info.ModTime())
	default:
		return fmt.Errorf("%s is a %s, not a file or folder", src, info.Mode().Type())
	}
}
