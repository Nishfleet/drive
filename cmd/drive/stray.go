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

var renameFile = os.Rename

// rclone refuses to mount a non-empty folder.
func strayHoldingDir(mountDir string) string {
	return mountDir + ".drive-local"
}

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
			kept = append(kept, e.Name())
			continue
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("look for %s in the drive: %w", e.Name(), err)
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

func moveIntoDrive(from, to string) error {
	err := renameFile(from, to)
	if err == nil || !errors.Is(err, syscall.EXDEV) {
		return err
	}
	if err := copyTree(from, to); err != nil {
		_ = os.RemoveAll(to)
		return err
	}
	return os.RemoveAll(from)
}

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
