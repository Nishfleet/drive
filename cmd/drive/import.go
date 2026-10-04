// `drive import` (drive issue #14): copy files from an rclone remote the user
// already has into the mounted drive folder. rclone's own `copy` does the
// work, against remotes `rclone config` created on this machine (Dropbox and
// Google Drive backends included). This CLI registers no OAuth app and holds
// no third-party credentials. The dest is the mount folder, so the running
// mount uploads the bytes the way every other save does.

package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

// importMounted is Mounted, swapped in tests so a copy can be proven without
// a live FUSE mount.
var importMounted = Mounted

// rcloneRemoteName is a remote the user already made with `rclone config`.
// Two or more characters so a Windows drive letter (`C:\...`) cannot pass as
// a remote, and no slash so a path cannot smuggle in.
var rcloneRemoteName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]+:`)

// ImportPlan is the rclone copy this command runs: source remote, dest mount
// folder, optional dry-run. Args() is the argument vector rclone sees.
type ImportPlan struct {
	RcloneBin string
	Source    string
	Dest      string
	DryRun    bool
}

// Args is rclone's own copy line: `copy <remote:path> <mount dir>`, plus
// `--dry-run` when asked. No config path: the source lives in the user's
// rclone config, and the dest is a local folder the mount already owns.
func (p ImportPlan) Args() []string {
	args := []string{"copy", p.Source, p.Dest}
	if p.DryRun {
		args = append(args, "--dry-run")
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

func importDest(goos, home string) (string, error) {
	if goos == "windows" {
		return windowsMountLetter()
	}
	return DefaultMountDir(home), nil
}

// BuildImportPlan is the copy this command would run. It refuses a source
// that is not an rclone remote, so a local path cannot be talked into
// looking like one.
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
	// The binary is the rclone path ResolveRclone already resolved to an
	// absolute path. exec.Command takes an argument vector and runs no shell.
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
