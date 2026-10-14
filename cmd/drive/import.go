package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var importMounted = Mounted

type cacheHeadroom struct {
	CapBytes  int64
	UsedBytes int64
}

// Free is the bytes the import may still add before the cache is full.
func (h cacheHeadroom) Free() int64 { return h.CapBytes - h.UsedBytes }

var importCacheHeadroom = func(home string) (cacheHeadroom, bool, error) {
	c, err := mountRCClient(home)
	if err != nil {
		return cacheHeadroom{}, false, err
	}
	ctx, cancel := rcCtx()
	defer cancel()
	s, err := c.cacheStats(ctx)
	if err != nil {
		return cacheHeadroom{}, false, err
	}
	if s.Opt.CacheMaxSize <= 0 {
		return cacheHeadroom{}, false, nil
	}
	return cacheHeadroom{CapBytes: s.Opt.CacheMaxSize, UsedBytes: s.DiskCache.BytesUsed}, true, nil
}

func importStop(h cacheHeadroom, known bool) (maxBytes int64, err error) {
	if !known {
		return 0, nil
	}
	if h.Free() <= 0 {
		return 0, fail("import-cache-full")
	}
	return h.Free(), nil
}

var rcloneRemoteName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]+:`)

// ImportPlan is the rclone copy this command runs: source remote, dest mount folder, optional dry-run.
type ImportPlan struct {
	RcloneBin string
	Source    string
	Dest      string
	DryRun    bool
	MaxBytes  int64
}

// Args is rclone's own copy line: `copy <remote:path> <mount dir>`, plus `--dry-run` when asked.
func (p ImportPlan) Args() []string {
	args := []string{"copy", p.Source, p.Dest}
	if p.DryRun {
		args = append(args, "--dry-run")
	}
	if p.MaxBytes > 0 {
		args = append(args, "--max-transfer", strconv.FormatInt(p.MaxBytes, 10), "--cutoff-mode", "soft")
	}
	return args
}

func checkImportSource(src string) error {
	if !rcloneRemoteName.MatchString(src) {
		return fail("import-source")
	}
	if strings.ContainsAny(src, " \t\r\n\x00") {
		return fail("import-source")
	}
	return nil
}

var windowsImportDest = func() (string, error) {
	letter, err := windowsMountLetter()
	if err != nil {
		return "", err
	}
	return windowsVolumeRoot(letter), nil
}

func importDest(goos, home string) (string, error) {
	if goos == "windows" {
		return windowsImportDest()
	}
	return DefaultMountDir(home), nil
}

// BuildImportPlan is the copy this command would run.
func BuildImportPlan(goos, home, rcloneBin, source string, dryRun bool) (ImportPlan, error) {
	if err := checkImportSource(source); err != nil {
		return ImportPlan{}, err
	}
	dest, err := importDest(goos, home)
	if err != nil {
		return ImportPlan{}, err
	}
	return ImportPlan{RcloneBin: rcloneBin, Source: source, Dest: dest, DryRun: dryRun}, nil
}

func runImport(args []string) error {
	fs := flag.NewFlagSet("import", flag.ContinueOnError)
	common := addCommonFlags(fs)
	dryRun := fs.Bool("dry-run", false, "print the copy rclone would run, copy nothing")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() != 1 {
		return fail("import-source")
	}
	source := fs.Arg(0)
	if err := checkImportSource(source); err != nil {
		return err
	}
	goos := CurrentGOOS()
	on, err := importMounted(goos, common.home)
	if err != nil {
		return err
	}
	if !on {
		return fail("import-not-mounted")
	}
	rcloneBin, err := ResolveRclone(common.rclone)
	if err != nil {
		return err
	}
	if err := CheckRclone(goos, rcloneBin); err != nil {
		return err
	}
	plan, err := BuildImportPlan(goos, common.home, rcloneBin, source, *dryRun)
	if err != nil {
		return err
	}
	if !*dryRun {
		headroom, known, err := importCacheHeadroom(common.home)
		if err != nil {
			return failDetail("import-cache-unknown", err, mountLogHint(goos, common.home))
		}
		maxBytes, err := importStop(headroom, known)
		if err != nil {
			return err
		}
		plan.MaxBytes = maxBytes
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(rcloneBin, plan.Args()...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return failDetail("import-failed", err)
	}
	if *dryRun {
		fmt.Println("Dry run. Nothing was copied.")
		return nil
	}
	fmt.Println("Imported " + source + " into the drive.")
	fmt.Println("Next: run `drive status` to watch the files land.")
	return nil
}
