package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

const usage = `drive - a Finder drive for people and their agents

Usage:
  drive login [flags]     connect this machine to your account and write its storage settings
  drive init [flags]      mount the drive, start it at login, and connect your agent tools
  drive agents [flags]                list agent tools and whether the drive is connected
  drive agents connect <tool> [flags]   connect one agent tool to the drive
  drive agents revoke <tool> [flags]    disconnect one agent tool from the drive
  drive search <words> [flags]          find files by name, from the drive index
  drive branch <folder> [flags]         copy a folder into a branch an agent works in
  drive branches [flags]                list branches and how many files changed
  drive diff <branch> [flags]           files added, changed or removed in a branch
  drive approve <branch> [flags]        copy a branch's changes back into the original
  drive discard <branch> [flags]        throw a branch away; the original is untouched
  drive undo [branch] [flags]           rewind the last branch an agent worked in
  drive mount [flags]      write the rclone config and login item, start the mount
  drive unmount [flags]    stop the mount and the login item
  drive offline <path>...  keep a file or folder on this computer (also --list)
  drive online [path]...   let the disk go again; with no argument, all of it
  drive prefetch [flags]   fetch what an app will open next, before it asks (login item)
  drive renew [flags]      renew this device's storage key before the vendor session ends
  drive uninstall [flags]  stop the mount, remove the login item, keep the files
  drive status [flags]     is it working, what is waiting, how much am I spending
  drive doctor [flags]     print the one block to paste into a support message
  drive pause [flags]      stop the bytes leaving the device; survives a restart
  drive resume [flags]     start the bytes leaving the device again
  drive cap <dollars>      change the spending cap
  drive cache              show the disk the mount's cache uses and its limit
  drive cache --max 5G     change that limit
  drive cache --clear      empty the cache; uploads still waiting and files kept offline stay
  drive share <file>       make a link anyone can open, logged out
  drive request <folder>   make a page anyone can drop files onto
  drive share --list       list this account's links (also on drive request)
  drive share --revoke <t> turn one link off (also on drive request)
  drive logout [flags]     stop the mount, revoke this device's key on the server, and delete the local key and config
  drive logout --all      sign out every device signed in to this account (--yes to confirm)
  drive export [flags]     write this account's data to a file (or stdout)
  drive import <remote>    copy files from an rclone remote you already have
  drive update [flags]     replace this binary with the latest release
  drive version            print the version

Install, one line per system, then run drive login and drive init:
  macOS                   brew install nish3451/tap/drive
  Linux, Debian or Ubuntu  sudo apt install ./drive_*.deb
  Linux, Fedora or RHEL    sudo dnf install ./drive_*.rpm

Linux: download the package for your CPU from the GitHub release first, then
run the line above in that folder. Windows: winget install Nishfleet.Drive
once a signed build is published.

drive update hands off to the package manager that installed this binary
(brew, apt, dnf or winget).

Update flags:
  --check   say whether a newer release exists, install nothing
  --home    where the drive lives (default $HOME); a mount that is up restarts on it
  --rclone  path to the rclone binary (default rclone from PATH)

Agent tools: claude, codex, cursor, gemini, kiro. Each tool is connected to the
stock MCP filesystem server over the drive folder, using the tool's own
mcp add command or its JSON config file.

Every failure prints what happened and the exact next step.
DRIVE_DEBUG=1 adds the underlying error detail, which is otherwise kept in
the mount's own log.

When something goes wrong, the docs have a page for it:
  https://storagebun.com/docs/troubleshooting

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
  --drive-letter  Windows: the drive letter to mount (first free letter from D:)
  --secret-key-stdin  read one line of the storage secret from stdin
  --home        home directory (default $HOME)
  --rclone      path to the rclone binary (env DRIVE_RCLONE, default rclone)
  --rc-addr     loopback address the mount's remote control binds (env
                DRIVE_RC_ADDR; default a free loopback port stored in rclone.env)
  --device      name this device is called in a conflict copy (env DRIVE_DEVICE,
                default the hostname, with a suffix when it is a stock model name)
  --foreground  run rclone in this process instead of the login item
  --dry-run     print what would be written, write nothing

Mount flags work on drive init too: init mounts the drive first, then
connects the agent tools, so one command takes a machine from nothing to a
mounted drive.

Login flags:
  --api    drive api base URL (env DRIVE_API_URL, default the live site)
  --device  name this device is called in the account (default the hostname,
            with a suffix when it is a stock model name)

Init flags:
  --api    drive api base URL (env DRIVE_API_URL), for each agent tool's own key

Link flags (share, request):
  --api         api Worker base URL (env DRIVE_API_URL)
  --list        list this account's links instead of minting one
  --revoke      revoke the link with this token (a full link URL also works)

Cache flags:
  --max     the cache limit, a size like 5G or 500M (default 20G)
  --clear   empty the cache now; uploads waiting and files kept offline stay

Export flags:
  --out   file to write the export to; stdout when it is not given

Doctor flags:
  --api          api Worker base URL (env DRIVE_API_URL)
  --logs <n>     how many log lines to print (default 20, 0 for none)

Import flags:
  --rclone   path to the rclone binary (env DRIVE_RCLONE, default rclone)
  --dry-run  print the copy rclone would run, copy nothing
  --home     home directory (default $HOME)

The access key id is read from the environment (DRIVE_S3_ACCESS_KEY_ID), never a flag.
The storage secret is read from the config file (mode 0600), DRIVE_S3_SECRET_ACCESS_KEY,
or --secret-key-stdin. --secret-key is refused.

Logout flags:
  --api         api Worker base URL (env DRIVE_API_URL), the key-revoke endpoint
  --force       discard files waiting to upload instead of refusing to logout
  --forget-pending  clear the failed-revoke record, after you have revoked the
               key on the devices page in the web app
  --all         sign out every device signed in to this account, not just this
               one. It prints what it would do and changes nothing without --yes
  --yes         answer yes to --all's confirm step
`

var commands = map[string]func([]string) error{
	"login":     runLogin,
	"init":      runInit,
	"agents":    runAgents,
	"search":    runSearch,
	"branch":    runBranch,
	"branches":  runBranches,
	"diff":      runDiff,
	"approve":   runApprove,
	"discard":   runDiscard,
	"undo":      runUndo,
	"mount":     runMount,
	"unmount":   runUnmount,
	"offline":   runOffline,
	"online":    runOnline,
	"uninstall": runUninstall,
	"status":    runStatus,
	"doctor":    runDoctor,
	"pause":     runPause,
	"resume":    runResume,
	"cap":       runCap,
	"cache":     runCache,
	"share":     runShare,
	"request":   runRequest,
	"logout":    runLogout,
	"export":    runExport,
	"import":    runImport,
	"update":    runUpdate,
	"prefetch":  runPrefetch,
	"renew":     runRenew,
}

var version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	installAccessTransport()
	var err error
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println(versionText())
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		run, ok := commands[os.Args[1]]
		if !ok {
			fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
			os.Exit(2)
		}
		err = run(os.Args[2:])
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return
		}
		if errors.Is(err, errFlagParse) {
			os.Exit(2)
		}
		os.Exit(printFailure(os.Stderr, err))
	}
}

var errFlagParse = errors.New("flag parse")

type commonFlags struct {
	home   string
	rclone string
}

func addCommonFlags(fs *flag.FlagSet) *commonFlags {
	c := &commonFlags{}
	fs.StringVar(&c.home, "home", DefaultHome(), "home directory")
	fs.StringVar(&c.rclone, "rclone", "", "path to the rclone binary (default rclone from PATH)")
	return c
}

type mountFlags struct {
	endpoint, bucket, prefix, region string
	downloadURL                      string
	device, rcAddr, driveLetter      string
	refusedSecret                    string
	secretStdin                      bool
	foreground                       bool
	dryRun                           bool
	common                           *commonFlags
}

func addStorageFlags(fs *flag.FlagSet) *mountFlags {
	m := &mountFlags{}
	fs.StringVar(&m.endpoint, "endpoint", "", "S3 endpoint URL")
	fs.StringVar(&m.bucket, "bucket", "", "storage bucket")
	fs.StringVar(&m.prefix, "prefix", "", "key prefix this device mounts")
	fs.StringVar(&m.region, "region", "", "S3 region name")
	fs.StringVar(&m.refusedSecret, "secret-key", "", "removed: the storage secret is never read from the command line")
	fs.BoolVar(&m.secretStdin, "secret-key-stdin", false, "read one line of the secret access key from stdin; what is already in the pipe after the first newline is a mistake, not a second try")
	fs.StringVar(&m.downloadURL, "download-url", "", "dl Worker to stream reads through")
	fs.StringVar(&m.device, "device", "", "name for this device in a conflict copy")
	fs.StringVar(&m.rcAddr, "rc-addr", "", "loopback address the mount's remote control binds")
	fs.StringVar(&m.driveLetter, "drive-letter", "", "Windows: the drive letter to mount (first free letter from D:)")
	m.common = addCommonFlags(fs)
	return m
}

func (m *mountFlags) resolve(fs *flag.FlagSet) (string, StorageConfig, error) {
	refused := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "secret-key" {
			refused = true
		}
	})
	if refused {
		return "", StorageConfig{}, fmt.Errorf("--secret-key is not accepted: %s\nnote: the value just typed is in the shell history and in ps for this run, so treat that key as exposed and roll it (then set the new one the safe way above)", secretWays(RcloneConfigPath(m.common.home)))
	}
	if m.driveLetter != "" && CurrentGOOS() != "windows" {
		return "", StorageConfig{}, errors.New("--drive-letter is only for Windows; on Mac and Linux the drive mounts at the drive folder")
	}
	secretKey, err := ReadSecretKey(RcloneConfigPath(m.common.home), m.secretStdin, os.Stdin)
	if err != nil {
		return "", StorageConfig{}, err
	}
	c, err := LoadStorageConfig(m.endpoint, m.bucket, m.prefix, m.region, m.downloadURL, secretKey, storageFromDisk(m.common.home))
	if err != nil {
		return "", StorageConfig{}, err
	}
	rclone, err := ResolveRclone(m.common.rclone)
	if err != nil {
		return "", StorageConfig{}, err
	}
	if strings.TrimSpace(m.device) != "" {
		_ = os.Setenv(deviceEnvName, m.device)
	}
	if strings.TrimSpace(m.rcAddr) != "" {
		if !IsLoopbackAddr(m.rcAddr) {
			return "", StorageConfig{}, fmt.Errorf("--rc-addr %s is not a loopback address: the mount's remote control "+
				"binds loopback only, so it stays on this machine", m.rcAddr)
		}
		_ = os.Setenv(rcAddrEnvName, m.rcAddr)
	}
	return rclone, c, nil
}

func runMount(args []string) error {
	fs := flag.NewFlagSet("mount", flag.ContinueOnError)
	m := addStorageFlags(fs)
	fs.BoolVar(&m.foreground, "foreground", false, "run rclone in this process")
	fs.BoolVar(&m.dryRun, "dry-run", false, "print what would be written, write nothing")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	rclone, c, err := m.resolve(fs)
	if err != nil {
		return err
	}
	if err := CheckRclone(CurrentGOOS(), rclone); err != nil {
		return err
	}
	return Mount(CurrentGOOS(), m.common.home, rclone, c, m.foreground, m.dryRun, m.driveLetter)
}

func runUnmount(args []string) error {
	fs := flag.NewFlagSet("unmount", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	goos := CurrentGOOS()
	home := common.home
	mountDir := DefaultMountDir(home)
	before, listErr := Mounted(goos, home)
	if listErr != nil {
		before = true
	}
	if err := Unmount(goos, home); err != nil {
		return err
	}
	after, err := Mounted(goos, home)
	if err != nil {
		return err
	}
	if after {
		return failf("unmount-failed", mountDir)
	}
	if before {
		fmt.Printf("drive: unmounted %s\n", mountDir)
	} else {
		fmt.Printf("drive: no mount at %s\n", mountDir)
	}
	return nil
}

// A FUSE mount whose backing store has gone away can block a plain ReadDir forever.
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
