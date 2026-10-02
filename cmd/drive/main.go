package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"
)

// usage is the command list from docs/build-spec.md. Step 2 of that spec ships
// mount, unmount and status; later steps add the rest.
const usage = `drive - a Finder drive for people and their agents

Usage:
  drive init [flags]                    find installed agent tools and connect each to the drive
  drive agents [flags]                  list agent tools and whether the drive is connected
  drive agents connect <tool> [flags]   connect one agent tool to the drive
  drive agents revoke <tool> [flags]    disconnect one agent tool from the drive
  drive search <words> [flags]          find files by name, from the drive index
  drive branch <folder> [flags]         copy a folder into a branch an agent works in
  drive branches [flags]                list branches and how many files changed
  drive diff <branch> [flags]           files added, changed or removed in a branch
  drive approve <branch> [flags]        copy a branch's changes back into the original
  drive discard <branch> [flags]        throw a branch away; the original is untouched
  drive mount [flags]      write the rclone config and login item, start the mount
  drive unmount [flags]    stop the mount and the login item
  drive status [flags]     the mount, the upload queue, and this month's cost
  drive cap <dollars>      change the spending cap
  drive share <file>       make a link anyone can open, logged out (issue #19)
  drive request <folder>   make a page anyone can drop files onto
  drive share --list       list this account's links (also on drive request)
  drive share --revoke <t> turn one link off (also on drive request)
  drive logout [flags]     stop the mount and delete this device's key and config
  drive export [flags]     write this account's data to a file (or stdout)
  drive version            print the version

Agent tools: claude, codex, cursor, gemini, kiro. Each tool is connected to the
stock MCP filesystem server over the drive folder, using the tool's own
mcp add command or its JSON config file.

Search flags:
  --api    drive api base URL (env DRIVE_API_URL)
  --limit  how many results to print (default 50, max 200)

Branch flags:
  --api    drive api base URL (env DRIVE_API_URL)
  --name   branch name (the folder's own name unless given)

Mount flags:
  --endpoint    S3 endpoint URL (env DRIVE_S3_ENDPOINT)
  --bucket      storage bucket (env DRIVE_S3_BUCKET)
  --prefix      key prefix this device mounts (env DRIVE_S3_PREFIX)
  --region      S3 region name (env DRIVE_S3_REGION, default us-east-1)
  --download-url dl Worker to stream reads through (env DRIVE_DOWNLOAD_URL)
  --home        home directory (default $HOME)
  --rclone      path to the rclone binary (env DRIVE_RCLONE, default rclone)
  --foreground  run rclone in this process instead of the login item
  --dry-run     print what would be written, write nothing

Link flags (share, request):
  --api         api Worker base URL (env DRIVE_API_URL)
  --list        list this account's links instead of minting one
  --revoke      revoke the link with this token (a full link URL also works)

Export flags:
  --out   file to write the export to; stdout when it is not given

The device keys are read from the environment, never a flag, so they stay out
of ps output and the shell history: DRIVE_S3_ACCESS_KEY_ID and
DRIVE_S3_SECRET_ACCESS_KEY.
`
const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "init":
		err = runInit(os.Args[2:])
	case "agents":
		err = runAgents(os.Args[2:])
	case "search":
		err = runSearch(os.Args[2:])
	case "branch":
		err = runBranch(os.Args[2:])
	case "branches":
		err = runBranches(os.Args[2:])
	case "diff":
		err = runDiff(os.Args[2:])
	case "approve":
		err = runApprove(os.Args[2:])
	case "discard":
		err = runDiscard(os.Args[2:])
	case "mount":
		err = runMount(os.Args[2:])
	case "unmount":
		err = runUnmount(os.Args[2:])
	case "status":
		err = runStatus(os.Args[2:])
	case "cap":
		err = runCap(os.Args[2:])
	case "share":
		err = runShare(os.Args[2:])
	case "request":
		err = runRequest(os.Args[2:])
	case "logout":
		err = runLogout(os.Args[2:])
	case "export":
		err = runExport(os.Args[2:])
	case "prefetch":
		err = runPrefetch(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		// A FlagSet with ContinueOnError has already printed the parse error
		// and the usage to stderr. --help is a success, and any other parse
		// error exits 2 (usage), not 1, so the shell can tell usage from
		// failure.
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		if errors.Is(err, errFlagParse) {
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "drive:", err)
		os.Exit(1)
	}
}

// errFlagParse marks an error the flag package has already printed, so main
// does not print it a second time.
var errFlagParse = errors.New("flag parse")

type commonFlags struct {
	home   string
	rclone string
}

func addCommonFlags(fs *flag.FlagSet) *commonFlags {
	c := &commonFlags{}
	fs.StringVar(&c.home, "home", os.Getenv("HOME"), "home directory")
	fs.StringVar(&c.rclone, "rclone", "", "path to the rclone binary (default rclone from PATH)")
	return c
}

func runMount(args []string) error {
	fs := flag.NewFlagSet("mount", flag.ContinueOnError)
	var endpoint, bucket, prefix, region, downloadURL string
	var foreground, dryRun bool
	fs.StringVar(&endpoint, "endpoint", "", "S3 endpoint URL")
	fs.StringVar(&bucket, "bucket", "", "storage bucket")
	fs.StringVar(&prefix, "prefix", "", "key prefix this device mounts")
	fs.StringVar(&region, "region", "", "S3 region name")
	// The dl Worker (drive issue #58). Absent, the mount reads from the
	// endpoint and counts nothing; set, every read streams through the dl
	// Worker so the account's download bytes are counted (docs/build-spec.md
	// "The pieces", items 2 and 4).
	fs.StringVar(&downloadURL, "download-url", "", "dl Worker to stream reads through")
	fs.BoolVar(&foreground, "foreground", false, "run rclone in this process")
	fs.BoolVar(&dryRun, "dry-run", false, "print what would be written")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	c, err := LoadStorageConfig(endpoint, bucket, prefix, region, downloadURL)
	if err != nil {
		return err
	}
	rclone, err := ResolveRclone(common.rclone)
	if err != nil {
		return err
	}
	return Mount(CurrentGOOS(), common.home, rclone, c, foreground, dryRun)
}

func runUnmount(args []string) error {
	fs := flag.NewFlagSet("unmount", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	return Unmount(CurrentGOOS(), common.home)
}

// countEntries lists a mount dir with a deadline. A FUSE mount whose backing
// store has gone away can block a plain ReadDir forever, and `drive status` is
// exactly the command a user runs when that happens, so it must still answer.
func countEntries(dir string, wait time.Duration) (int, error) {
	type result struct {
		n   int
		err error
	}
	done := make(chan result, 1)
	go func() {
		files, err := os.ReadDir(dir)
		done <- result{len(files), err}
	}()
	select {
	case r := <-done:
		return r.n, r.err
	case <-time.After(wait):
		return 0, fmt.Errorf("timed out after %s", wait)
	}
}
