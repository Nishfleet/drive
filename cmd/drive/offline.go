package main

import (
	"context"
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

// OfflineIndex is what this computer keeps offline: paths relative to the mount root, in the order they were asked for.
type OfflineIndex struct {
	Paths []string `json:"paths"`
}

// Empty reports whether nothing is kept offline, which is the answer a person gets on a fresh install and the state `drive online` with no argument leaves the machine in.
func (o OfflineIndex) Empty() bool { return len(o.Paths) == 0 }

// Has reports whether rel is in the set.
func (o OfflineIndex) Has(rel string) bool {
	for _, p := range o.Paths {
		if p == rel {
			return true
		}
	}
	return false
}

// Add puts rel in the set and reports whether it was not there already.
func (o *OfflineIndex) Add(rel string) bool {
	if o.Has(rel) {
		return false
	}
	o.Paths = append(o.Paths, rel)
	return true
}

// Remove takes rel out of the set.
func (o *OfflineIndex) Remove(rel string) bool {
	for i, p := range o.Paths {
		if p == rel {
			o.Paths = append(o.Paths[:i], o.Paths[i+1:]...)
			return true
		}
	}
	return false
}

// OfflineIndexPath is where the list of kept-offline paths lives.
func OfflineIndexPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "offline.json")
}

// LoadOffline reads the kept-offline list.
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
		return OfflineIndex{}, failDetail("offline-list-unreadable", err, OfflineIndexPath(home))
	}
	return idx, nil
}

// SaveOffline writes the list back atomically, so a machine that loses power mid-write keeps the list it had rather than an empty one.
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

// OfflineRelative normalises what a person typed into a path relative to the mount root, or refuses it.
func OfflineRelative(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("no path given")
	}
	slashed := strings.ReplaceAll(trimmed, `\`, "/")
	slashed = strings.TrimPrefix(slashed, "/")
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

// OfflineUsage is one kept-offline path and what it costs on disk: how many files it holds and how many bytes they are.
type OfflineUsage struct {
	Path  string
	Files int
	Bytes int64
}

// MeasureOffline adds up what each kept path holds.
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

// TotalOffline sums each path's own files and bytes.
func TotalOffline(usage []OfflineUsage) (files int, bytes int64) {
	for _, u := range usage {
		files += u.Files
		bytes += u.Bytes
	}
	return files, bytes
}

// UniqueOffline counts each file once, even when a folder and a file inside it are both on the kept-offline list, so the cap and the status total are the disk the set actually uses.
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

func overOfflineCap(bytes, cap int64) bool {
	return cap > 0 && bytes > cap
}

func offlineCapError(bytes, cap int64) error {
	return fmt.Errorf("keeping this offline needs %s and the cache limit is %s; raise it with `drive cache --max` or keep less",
		FormatBytes(bytes), FormatBytes(cap))
}

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

// OfflineCapBytes is the limit a kept-offline set has to fit inside: the same `--vfs-cache-max-size` the mount runs with, which is the value `drive cache --max` wrote or the shipped 20G default.
func OfflineCapBytes(home string) (int64, error) {
	maxSize, err := ResolveCacheMax(home)
	if err != nil {
		return 0, err
	}
	return parseSizeSuffix(maxSize)
}

// KeepOffline downloads a full copy of rel into rclone's VFS cache and reports how many bytes it read.
func KeepOffline(ctx context.Context, mountDir, rel string) (int64, error) {
	full := filepath.Join(mountDir, filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", rel, err)
	}
	if !info.IsDir() {
		return fillReadFile(ctx, full)
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
		n, err := fillReadFile(ctx, p)
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
		n, err := KeepOffline(context.Background(), mountDir, rel)
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

func pluralPaths(n int) string {
	if n == 1 {
		return "path"
	}
	return "paths"
}
