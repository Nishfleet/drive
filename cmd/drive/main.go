package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
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
  drive mount [flags]      write the rclone config and login item, start the mount
  drive unmount [flags]    stop the mount and the login item
  drive status [flags]     the mount, the upload queue, and this month's cost
  drive logout [flags]     stop the mount, revoke this device's key on the server, and delete the local key and config
  drive version            print the version

Agent tools: claude, codex, cursor, gemini, kiro. Each tool is connected to the
stock MCP filesystem server over the drive folder, using the tool's own
mcp add command or its JSON config file.

Mount flags:
  --endpoint    S3 endpoint URL (env DRIVE_S3_ENDPOINT)
  --bucket      storage bucket (env DRIVE_S3_BUCKET)
  --prefix      key prefix this device mounts (env DRIVE_S3_PREFIX)
  --region      S3 region name (env DRIVE_S3_REGION, default us-east-1)
  --access-key  access key id (env DRIVE_S3_ACCESS_KEY_ID)
  --secret-key-stdin  read the secret access key from stdin, one line of it
  --home        home directory (default $HOME)
  --rclone      path to the rclone binary (env DRIVE_RCLONE, default rclone)
  --foreground  run rclone in this process instead of the login item
  --dry-run     print what would be written, write nothing

The storage secret is read from the config file (mode 0600), the environment
variable DRIVE_S3_SECRET_ACCESS_KEY, or stdin; it is never accepted on the
command line, where the shell history and ps output would keep a copy.

Logout flags:
  --api         api Worker base URL (env DRIVE_API_URL), the key-revoke endpoint
  --force       discard files waiting to upload instead of refusing to logout
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
	case "mount":
		err = runMount(os.Args[2:])
	case "unmount":
		err = runUnmount(os.Args[2:])
	case "status":
		err = runStatus(os.Args[2:])
	case "logout":
		err = runLogout(os.Args[2:])
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
	// The storage secret is refused before the FlagSet parses, because the
	// parse would stop at "flag provided but not defined" and name neither the
	// reason nor the ways that are safe. The secret itself is never held: only
	// the flag's presence is read here.
	if flag := secretFlagArg(args); flag != "" {
		return fmt.Errorf("%s is not accepted: %s", flag, secretWays(RcloneConfigPath(homeFromArgs(args))))
	}
	fs := flag.NewFlagSet("mount", flag.ContinueOnError)
	var endpoint, bucket, prefix, region, accessKey string
	var secretStdin, foreground, dryRun bool
	fs.StringVar(&endpoint, "endpoint", "", "S3 endpoint URL")
	fs.StringVar(&bucket, "bucket", "", "storage bucket")
	fs.StringVar(&prefix, "prefix", "", "key prefix this device mounts")
	fs.StringVar(&region, "region", "", "S3 region name")
	fs.StringVar(&accessKey, "access-key", "", "access key id")
	fs.BoolVar(&secretStdin, "secret-key-stdin", false, "read the secret access key from stdin")
	fs.BoolVar(&foreground, "foreground", false, "run rclone in this process")
	fs.BoolVar(&dryRun, "dry-run", false, "print what would be written")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	secretKey, err := ReadSecretKey(RcloneConfigPath(common.home), secretStdin, os.Stdin)
	if err != nil {
		return err
	}
	c, err := LoadStorageConfig(endpoint, bucket, prefix, region, accessKey, secretKey)
	if err != nil {
		return err
	}
	rclone := common.rclone
	if rclone == "" {
		rclone = DefaultRcloneBin(common.home)
	}
	return Mount(CurrentGOOS(), common.home, rclone, c, foreground, dryRun)
}

// secretFlagArg returns the command line's own --secret-key argument when it
// is present in any spelling the flag package would accept (-secret-key,
// --secret-key, or either with =value), and empty when it is not. The value
// after = is not returned: it is a secret, and nothing here prints it.
func secretFlagArg(args []string) string {
	for _, a := range args {
		name := strings.TrimLeft(a, "-")
		if name == "secret-key" || strings.HasPrefix(name, "secret-key=") {
			return "--secret-key"
		}
	}
	return ""
}

// homeFromArgs reads the --home value the flag package would use, so a message
// about the config file names the file this run would actually read. The flags
// have not parsed yet, so this scans only the one flag it needs, in both the
// `--home X` and `--home=X` spellings; anything malformed falls back to $HOME,
// which is what a failed parse would have failed on anyway.
func homeFromArgs(args []string) string {
	for i, a := range args {
		if a == "--home" || a == "-home" {
			if i+1 < len(args) {
				return args[i+1]
			}
			return os.Getenv("HOME")
		}
		for _, prefix := range []string{"--home=", "-home="} {
			if v, ok := strings.CutPrefix(a, prefix); ok {
				return v
			}
		}
	}
	return os.Getenv("HOME")
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
