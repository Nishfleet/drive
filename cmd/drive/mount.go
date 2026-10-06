package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MountPlan is everything needed to mount this device's drive with stock
// rclone. The remote is the device's own S3 bucket path; the endpoint and keys
// live in the rclone config this CLI writes, so the same plan works against the
// local S3 stand-in and against the real storage (step 1) with no code change.
type MountPlan struct {
	// err carries a failure that must stop the mount (issue #112): a
	// cache-max file the machine cannot read. Mount() returns it rather than
	// starting a mount whose limit nobody can state.
	err        error
	GOOS       string
	RcloneBin  string
	Subcommand string // "nfsmount" on macOS, "mount" on Linux
	Remote     string // drive:<bucket>/<prefix>
	MountDir   string
	ConfigPath string
	CacheDir   string
	// CacheMax is the resolved cache limit this plan mounts with, so the
	// command line, the login item and `drive cache` report one number.
	CacheMax string
	LogPath  string
	// Bwlimit is the rclone rate the mount starts with, "" for no limit
	// (drive issue #100). PausedRate(home) fills it, so a mount started again
	// after `drive pause` comes back already paused.
	Bwlimit string
	VFSArgs []string
	// Device is this machine's name in a conflict copy's filename
	// (issue #30). DRIVE_DEVICE when the operator sets it, else the
	// hostname, sanitized so it is a filename everywhere the mount
	// goes.
	Device string
	// RCAddr is the loopback address the mount's remote control binds.
	// The background fill, the conflict guard and every operator
	// reach the same one, so it is on the plan rather than a constant
	// each of them keeps.
	RCAddr string
	// DownloadURL is the dl Worker (drive issue #58, build step 5), empty
	// when none is configured. It is a mount argument, not a line in the
	// rclone config the user owns: rclone streams every read through the
	// host, and the host counts the bytes, so a mount that did not point at
	// it would serve reads nobody bills.
	DownloadURL string
	// RCUser and RCPass are the random remote-control credentials this
	// mount generated. Empty on a plan that has not been prepared for a
	// real start (tests of the public flags). Args() passes them as
	// --rc-user/--rc-pass; the systemd unit leaves them out of ExecStart
	// and puts them in the 0600 EnvironmentFile instead (drive#498).
	RCUser string
	RCPass string
	// SecretKey is the storage secret passed at mount time through
	// RCLONE_CONFIG_DRIVE_SECRET_ACCESS_KEY, never written into rclone.conf.
	SecretKey string
}

// VFSArgs are the stock rclone VFS flags this product mounts with. The docs
// for rclone's mount and nfsmount commands describe each one.
//
// cacheMax is the person's cache limit (issue #112): the value `drive cache
// --max` wrote, or the shipped 20G default when they never chose one. It is a
// parameter rather than a constant read here, so the number in the mount args,
// the number in the mount's live options and the number `drive cache` prints
// are one value resolved once in ResolveCacheMax rather than three.
//
// The tunable values (read-ahead, chunk size, chunk streams, buffer size,
// transfers) may be overridden by a DRIVE_BENCH_<FLAG> environment variable
// (e.g. DRIVE_BENCH_VFS_READ_AHEAD=0). That is the speed hill-climb's (issue
// #224) only handle on the value: the product mounts with the constants
// above, the climb measures a candidate by setting the one variable for the
// round, and a person's real mount never sets it. The four safety values are
// NOT overridable, and TestVFSArgsPinsTheSafetyFlags fails if anything
// changes them.
func VFSArgs(cacheMax string) []string {
	return []string{
		"--vfs-cache-mode", vfsCacheModeValue,
		"--vfs-write-back", vfsWriteBackValue,
		"--vfs-cache-max-size", cacheMax,
		// The second half of the cap, and it is on every mount (issue #112):
		// rclone will not let the cache take the disk it lives on below this
		// much free space, whatever the max-size above would allow. That is
		// what makes a cap a cap rather than a promise.
		"--vfs-cache-min-free-space", vfsCacheMinFreeSpaceValue,
		// S3 sends no change notifications, so without a short directory cache
		// a save made on the other machine waits out rclone's 5-minute default
		// before it is visible here. The step-3 two-machine proof measured it
		// against a local S3 stand-in (issue #62, PR #61): about 5 s with the
		// flag, still absent after 60 s without.
		"--dir-cache-time", vfsDirCacheTimeValue,
		"--vfs-read-chunk-size", tunedVFSValue("VFS_READ_CHUNK_SIZE", vfsReadChunkSizeValue),
		"--vfs-read-chunk-streams", tunedVFSValue("VFS_READ_CHUNK_STREAMS", vfsReadChunkStreamsValue),
		"--buffer-size", tunedVFSValue("BUFFER_SIZE", vfsChunkStreamSize),
		"--transfers", tunedVFSValue("TRANSFERS", vfsTransfersValue),
		// --vfs-read-ahead is the stock flag that covers "the first chunk of a
		// file already being read" with --vfs-cache-mode full. It does not
		// prefetch child listings when a folder is listed; that has no flag
		// (rclone's --vfs-refresh walks the whole tree at mount start, which
		// is the wrong trigger and delays mount-ready), so drive prefetch
		// does only that leftover work. A round may retune the value through
		// DRIVE_BENCH_VFS_READ_AHEAD; a person's real mount never sets it.
		"--vfs-read-ahead", tunedVFSValue("VFS_READ_AHEAD", vfsReadAheadValue),
		// Background fill (issue #194): the rest of a file arrives without a
		// foreground read asking for it. The two flags below are the fill's
		// own and each one's reason is in fill.go:
		// --vfs-read-chunk-size-limit caps rclone's own chunk doubling, so
		// the tail of a partly-read 10 GB file arrives in a few large
		// requests instead of the 128M chunks the doubling would otherwise
		// start from; --vfs-cache-max-age is how long a file somebody opened
		// stays on the disk, which is what "recently opened files" means
		// without a second index.
		"--vfs-read-chunk-size-limit", vfsChunkSizeLimit(),
		"--vfs-cache-max-age", vfsMaxAge(),
	}
}

// tunedVFSValue returns the shipped value for a tunable flag unless the hill
// climb has set its DRIVE_BENCH_<flag> variable, in which case the override is
// used. A set-but-empty variable is ignored and the shipped value is used, so
// a blank round cannot pass rclone an empty flag. Non-empty values are the
// climb's candidates; flagPairsEnv refuses one that is not a size or a count.
func tunedVFSValue(envSuffix, shipped string) string {
	if v, ok := os.LookupEnv("DRIVE_BENCH_" + envSuffix); ok {
		if strings.TrimSpace(v) == "" {
			return shipped
		}
		return v
	}
	return shipped
}

// RemoteFor joins the bucket and optional key prefix into an rclone remote
// path. The prefix is the device's scoped folder, e.g. u/<id>.
func RemoteFor(c StorageConfig) string {
	prefix := strings.Trim(c.Prefix, "/")
	if prefix == "" {
		return RcloneRemoteName + ":" + c.Bucket
	}
	return RcloneRemoteName + ":" + c.Bucket + "/" + prefix
}

// BuildMountPlan resolves the mount command for goos. It is the single place
// that knows nfsmount is the macOS command and mount is the Linux one, and
// the single place the paused state is translated into rclone's command line
// (drive issue #100).
func BuildMountPlan(goos, home, rcloneBin string, c StorageConfig) MountPlan {
	// The limit the person chose, falling back to the shipped default. A
	// unreadable or nonsense cache-max file is a named error, not a quiet
	// 20G: ResolveCacheMax says which file and what it held.
	cacheMax, err := ResolveCacheMax(home)
	if err != nil {
		return MountPlan{CacheMax: vfsCacheMaxValue, err: err}
	}
	sub := "mount"
	if goos == "darwin" {
		sub = "nfsmount"
	}
	return MountPlan{
		GOOS:        goos,
		RcloneBin:   rcloneBin,
		Subcommand:  sub,
		Remote:      RemoteFor(c),
		MountDir:    mountDirFor(goos, home),
		ConfigPath:  RcloneConfigPath(home),
		CacheDir:    DefaultCacheDir(home),
		CacheMax:    cacheMax,
		LogPath:     filepath.Join(DefaultConfigDir(home), "mount.log"),
		VFSArgs:     VFSArgs(cacheMax),
		Device:      DeviceName(),
		RCAddr:      RCAddr(),
		DownloadURL: c.DownloadURL,
		// A pause that is in force when the mount is (re)started keeps being in
		// force (drive issue #100): rclone's bandwidth limit lives in its own
		// process, so without this line a restart would start sending bytes at
		// full speed and the marker file would say Paused over bytes that are
		// already leaving.
		Bwlimit: PausedRate(home),
	}
}

// prepareMountAuth puts the remote-control user and password on the plan,
// stores them with the storage secret in rclone.env (mode 0600), and returns.
// Args() and the login item pass --rc-user/--rc-pass (or, for systemd, read
// them from EnvironmentFile=). The pair already on disk is reused, so a
// re-run of the same plan writes the same bytes (issue #561): the running
// rclone keeps answering the CLI's own rc calls with the credentials in that
// file, and a plain re-run can then skip the restart. Only a first mount, or
// one after a login that cleared them, mints a new pair; a rotated storage
// secret arrives through the config and makes the bytes differ, which the
// caller counts as a changed plan.
func prepareMountAuth(home string, p *MountPlan, c StorageConfig) error {
	auth, err := ReadRCAuth(home)
	if err != nil {
		return err
	}
	if auth.User == "" || auth.Pass == "" {
		user, pass, err := generateRCAuth()
		if err != nil {
			return err
		}
		auth = RCAuth{User: user, Pass: pass}
	}
	p.RCUser = auth.User
	p.RCPass = auth.Pass
	p.SecretKey = c.SecretKey
	return WriteRcloneEnv(home, c, auth.User, auth.Pass)
}

func generateRCAuth() (user, pass string, err error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", "", fmt.Errorf("generate rclone rc password: %w", err)
	}
	return hex.EncodeToString(buf[:16]), hex.EncodeToString(buf[16:]), nil
}

func rcloneProcessEnv(p MountPlan) []string {
	env := os.Environ()
	if p.RCUser != "" {
		env = overrideEnv(env, rcloneRCUserEnv, p.RCUser)
		env = overrideEnv(env, rcloneRCPassEnv, p.RCPass)
	}
	if p.SecretKey != "" {
		env = overrideEnv(env, rcloneSecretEnv, p.SecretKey)
	}
	if p.DownloadURL != "" {
		env = overrideEnv(env, rcloneDownloadURLEnv, p.DownloadURL)
	}
	return env
}

func overrideEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, prefix) {
			out = append(out, e)
		}
	}
	return append(out, prefix+value)
}

func rcloneEnvRedacted(p MountPlan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s=<redacted>\n", rcloneRCUserEnv)
	fmt.Fprintf(&b, "%s=<redacted>\n", rcloneRCPassEnv)
	fmt.Fprintf(&b, "%s=<redacted>\n", rcloneSecretEnv)
	return b.String()
}

func rcClientForMount(p MountPlan) *rcClient {
	c := newRCClient(p.RcloneBin, p.RCAddr, p.Remote)
	c.user, c.pass = p.RCUser, p.RCPass
	return c
}

// deviceEnvName is the environment variable that carries the device name
// (issue #30). The flag is the person's own command; the environment is
// what the login item (launchd, systemd) carries forward.
const deviceEnvName = "DRIVE_DEVICE"

// DeviceName is the name this device carries in a conflict copy's
// filename (issue #30). DRIVE_DEVICE wins so a person's machine can
// answer to the name they chose ("studio", not "Johns-Macbook-Pro");
// otherwise the hostname, sanitized. An unset DRIVE_DEVICE is the common
// case and never an error: the hostname is a name.
func DeviceName() string {
	if set := strings.TrimSpace(os.Getenv(deviceEnvName)); set != "" {
		if name := SanitizeDevice(set); name != "" {
			return name
		}
	}
	return DefaultDeviceName()
}

// rcAddrEnvName is the environment variable that carries the remote
// control's loopback address. Two mounts of the same drive on one host
// (the two-machine proof, issue #30) cannot both bind one address, so the
// address is overridable; the constant below is the shipped value and a
// person's mount never sets either.
const rcAddrEnvName = "DRIVE_RC_ADDR"

// RCAddr is the loopback address the mount's remote control binds.
// rclone's remote control is authenticated (drive#498), and it still binds
// to loopback only and never to a wildcard: the background fill, the
// conflict guard and `drive status` all reach this one address. A
// DRIVE_RC_ADDR that is not a loopback address is refused and the shipped
// address is used, because a wildcard bind would put a control port on the
// network.
func RCAddr() string {
	if set := strings.TrimSpace(os.Getenv(rcAddrEnvName)); set != "" {
		if IsLoopbackAddr(set) {
			return set
		}
		return loopbackRCAddr
	}
	return loopbackRCAddr
}

// IsLoopbackAddr reports whether addr is a loopback host:port. The remote
// control binds loopback even with a password (drive#498), so anything that
// would bind off the machine is refused rather than used.
func IsLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	switch strings.ToLower(host) {
	case "localhost", "localhost.":
		return true
	}
	return false
}

// mountDirFor is the mount point for goos: ~/Drive on Mac and Linux, and the
// first drive-letter candidate on Windows, which Mount replaces with the first
// free letter from D: up (WindowsDriveLetter).
func mountDirFor(goos, home string) string {
	if goos == "windows" {
		return windowsDefaultLetter
	}
	return DefaultMountDir(home)
}

// Args is the full rclone argument vector, in the order the docs show. When
// RCUser is set it includes --rc-user/--rc-pass, which is what a foreground
// or detached rclone process gets. The systemd unit uses loginItemArgs so the
// password is not copied into a 0644 file.
func (p MountPlan) Args() []string {
	return p.args(true)
}

func (p MountPlan) loginItemArgs() []string {
	return p.args(false)
}

func (p MountPlan) args(includeRCAuth bool) []string {
	args := []string{
		p.Subcommand,
		p.Remote,
		p.MountDir,
		"--config", p.ConfigPath,
	}
	args = append(args, p.VFSArgs...)
	args = append(args,
		"--cache-dir", p.CacheDir,
		"--log-file", p.LogPath,
		"--log-level", "INFO",
		// The remote control is how the background fill reads the cache's
		// live state and refreshes the directory (fill_run.go), how the
		// conflict guard reads this device's own upload queue and the
		// object's hash at a path (conflict_guard.go), and how `drive
		// status` reports the cache. It is one address for all of them.
		// --rc-user/--rc-pass are rclone's own auth (drive#498); without
		// them config/dump returns the storage secret to any local process.
		"--rc", "--rc-addr", p.RCAddr,
	)
	if includeRCAuth && p.RCUser != "" {
		args = append(args, "--rc-user", p.RCUser, "--rc-pass", p.RCPass)
	}
	// The download host, when one is configured (issue #58), is the S3
	// backend's download_url: reads on the mount go to the dl Worker and are
	// counted. It is not passed here as --s3-download-url, because the URL
	// carries the key's download grant (drive#517) and the command line is
	// readable by every local process. It rides in the 0600 environment as
	// RCLONE_CONFIG_DRIVE_DOWNLOAD_URL instead (rcloneProcessEnv, rclone.env,
	// the plist's EnvironmentVariables). With none configured the mount reads
	// from the endpoint itself.
	// The paused rate goes on rclone's own command line, so a mount that is
	// started again after a `drive pause` comes back already paused. Measured
	// on this host 2026-10-03 (rclone v1.75.1): --bwlimit "1KiB:off" started
	// the mount with the same rate `core/bwlimit rate="1KiB:off"` sets, and
	// RCLONE_BWLIMIT is not needed because the flag is already in the vector.
	// The remote control that `drive pause` and `drive resume` use is the same
	// loopback address this vector binds (`--rc-addr`, p.RCAddr), so those
	// commands talk to this mount and no second listener is added.
	if p.Bwlimit != "" {
		args = append(args, "--bwlimit", p.Bwlimit)
	}
	return args
}

// CommandLine is the shell-safe rendering of Args, used in messages.
func (p MountPlan) CommandLine() string {
	parts := append([]string{p.RcloneBin}, p.Args()...)
	for i, a := range parts {
		if strings.ContainsAny(a, " \t\"'") {
			parts[i] = "'" + strings.ReplaceAll(a, "'", "'\\''") + "'"
		}
	}
	return strings.Join(parts, " ")
}

// LaunchdPlist renders the macOS login item that keeps the mount running. The
// label and program arguments are exactly the rclone plan, so what launchd runs
// is what `drive mount` would run in the foreground.
func LaunchdPlist(p MountPlan) string {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	b.WriteString("<plist version=\"1.0\">\n<dict>\n")
	fmt.Fprintf(&b, "\t<key>Label</key>\n\t<string>%s</string>\n", html.EscapeString(LaunchdLabel))
	b.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, a := range append([]string{p.RcloneBin}, p.Args()...) {
		fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString(a))
	}
	b.WriteString("\t</array>\n")
	b.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	b.WriteString("\t<key>KeepAlive</key>\n\t<true/>\n")
	fmt.Fprintf(&b, "\t<key>StandardOutPath</key>\n\t<string>%s</string>\n", html.EscapeString(p.LogPath))
	fmt.Fprintf(&b, "\t<key>StandardErrorPath</key>\n\t<string>%s</string>\n", html.EscapeString(p.LogPath))
	if p.RCUser != "" || p.SecretKey != "" || p.DownloadURL != "" {
		// The plist is written 0600 (the launchd equivalent of systemd's
		// EnvironmentFile): EnvironmentVariables carry the rc password and
		// the storage secret, so they never sit in a 0644 file (drive#498).
		b.WriteString("\t<key>EnvironmentVariables</key>\n\t<dict>\n")
		if p.RCUser != "" {
			fmt.Fprintf(&b, "\t\t<key>%s</key>\n\t\t<string>%s</string>\n", rcloneRCUserEnv, html.EscapeString(p.RCUser))
			fmt.Fprintf(&b, "\t\t<key>%s</key>\n\t\t<string>%s</string>\n", rcloneRCPassEnv, html.EscapeString(p.RCPass))
		}
		if p.SecretKey != "" {
			fmt.Fprintf(&b, "\t\t<key>%s</key>\n\t\t<string>%s</string>\n", rcloneSecretEnv, html.EscapeString(p.SecretKey))
		}
		if p.DownloadURL != "" {
			fmt.Fprintf(&b, "\t\t<key>%s</key>\n\t\t<string>%s</string>\n", rcloneDownloadURLEnv, html.EscapeString(p.DownloadURL))
		}
		b.WriteString("\t</dict>\n")
	}
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

// SystemdUnit renders the Linux login item (step 3). It is generated here so
// the same plan drives both platforms and `drive mount` is one code path.
// There is no ExecStop line: rclone unmounts on SIGTERM (its own docs), and
// SIGTERM is exactly what systemd sends a stopping unit by default, so an
// rclone command that does not exist would only break the stop.
func SystemdUnit(p MountPlan) string {
	return fmt.Sprintf(`[Unit]
Description=drive: %s mounted with stock rclone
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%s
ExecStart=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, p.Remote, systemdEscapeArg(filepath.Join(filepath.Dir(p.ConfigPath), "rclone.env")), systemdCommandLine(p))
}

// systemdCommandLine renders the rclone argument vector the way systemd reads
// it, not the way a shell would: systemd has its own quoting rules for
// ExecStart (double quotes with backslash and quote escaped, and every percent
// doubled for its %-specifier expansion). CommandLine stays shell-shaped for
// human display only.
func systemdCommandLine(p MountPlan) string {
	parts := append([]string{p.RcloneBin}, p.loginItemArgs()...)
	for i, a := range parts {
		parts[i] = systemdEscapeArg(a)
	}
	return strings.Join(parts, " ")
}

// systemdEscapeArg quotes one ExecStart argument per systemd.syntax: arguments
// are split on whitespace, so an argument containing whitespace, a quote or a
// backslash is double-quoted with those characters escaped, and every percent
// is doubled because systemd expands % specifiers in the command.
func systemdEscapeArg(arg string) string {
	arg = strings.ReplaceAll(arg, "%", "%%")
	if !strings.ContainsAny(arg, " \t\"'\\") {
		return arg
	}
	arg = strings.ReplaceAll(arg, `\`, `\\`)
	arg = strings.ReplaceAll(arg, `"`, `\"`)
	return `"` + arg + `"`
}

// LoginItemPath is where the login item for goos is written. Windows has no
// login-item file: its item is a Task Scheduler task (WindowsTaskName),
// registered with the OS, so the empty string is the honest answer for the
// file-shaped callers.
func LoginItemPath(goos, home string) string {
	switch goos {
	case "darwin":
		return LaunchdPlistPath(home)
	case "windows":
		return ""
	default:
		return SystemdUnitPath(home)
	}
}

// LoginItem renders the login item for goos.
func LoginItem(goos string, p MountPlan) string {
	switch goos {
	case "darwin":
		return LaunchdPlist(p)
	case "windows":
		return WindowsTaskCommandLine(p)
	default:
		return SystemdUnit(p)
	}
}

// LoginItemPresent answers whether the login item for goos is registered. On
// Windows that is the Task Scheduler task, not a file; on Mac and Linux it is
// the item file.
func LoginItemPresent(goos, home string) (bool, error) {
	if goos == "windows" {
		return windowsTaskPresent(WindowsTaskName)
	}
	path := LoginItemPath(goos, home)
	if _, err := os.Stat(path); err == nil {
		return true, nil
	} else if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	} else {
		return false, fmt.Errorf("stat %s: %w", path, err)
	}
}

// LoginItemFiles are the on-disk login-item files for goos. Windows has none:
// its login item is the Task Scheduler task, which Unmount removes through
// schtasks, so the file-removal paths have nothing to unlink.
func LoginItemFiles(goos, home string) []string {
	if goos == "windows" {
		return nil
	}
	return []string{LoginItemPath(goos, home), PrefetchLoginItemPath(goos, home)}
}

// Mount writes the rclone config and the login item, then starts the mount.
// foreground runs rclone in this process (used by the proof and by debugging);
// otherwise the login item starts it (launchd on macOS, systemd on Linux).
func Mount(goos, home, rcloneBin string, c StorageConfig, foreground, dryRun bool, driveLetter string) error {
	p := BuildMountPlan(goos, home, rcloneBin, c)
	if p.err != nil {
		return p.err
	}
	// Windows is its own path: a drive letter, a WinFsp check and a Task
	// Scheduler login task, and no prefetch sidecar (there is no Windows
	// directory watcher). The letter is resolved here, where an error can be
	// returned, and the plan carries it into the task's command line.
	if goos == "windows" {
		letter, err := WindowsDriveLetter(driveLetter, driveLetterFree)
		if err != nil {
			return err
		}
		p.MountDir = letter
		return mountWindows(p, home, c, foreground, dryRun)
	}
	itemPath := LoginItemPath(goos, home)
	itemMode := os.FileMode(0o644)
	if goos == "darwin" {
		itemMode = 0o600
	}
	// The mount dir is created only once the plan is real: --dry-run writes
	// nothing at all, and prints the config with both keys redacted.
	driveBin, exeErr := os.Executable()
	if exeErr != nil {
		return fmt.Errorf("resolve drive binary: %w", exeErr)
	}
	prefetchItem := []byte(PrefetchLoginItem(goos, driveBin, home))
	prefetchPath := PrefetchLoginItemPath(goos, home)
	if dryRun {
		p.RCUser, p.RCPass = "<redacted>", "<redacted>"
		item := []byte(LoginItem(goos, p))
		fmt.Printf("--- %s ---\n%s", p.ConfigPath, RcloneConfigRedacted(c))
		fmt.Printf("--- %s ---\n%s", RcloneEnvPath(home), rcloneEnvRedacted(p))
		fmt.Printf("--- %s ---\n%s", itemPath, item)
		fmt.Printf("--- %s ---\n%s", prefetchPath, prefetchItem)
		fmt.Printf("--- would run ---\n%s\n", p.CommandLine())
		return nil
	}
	// The device name this mount answers to in a conflict copy. It is a
	// filename, so it is sanitized whatever the operator typed or the
	// hostname carries, and a refusal here is a named failure at the person's
	// own command rather than a conflict file with an unreadable name.
	if p.Device == "" {
		return fmt.Errorf("device name is empty: set --device or DRIVE_DEVICE to a name " +
			"this mount can carry in a conflict filename")
	}
	// The rclone env carries the remote-control credentials and the storage
	// secret. prepareMountAuth reuses the credentials already on disk, so a
	// plain re-run writes the same bytes and a rotated secret writes new
	// ones; comparing before and after is how a changed secret counts as a
	// changed plan (issue #561) while an unchanged re-run does not.
	envBefore, envBeforeErr := os.ReadFile(RcloneEnvPath(home))
	if err := prepareMountAuth(home, &p, c); err != nil {
		return err
	}
	envAfter, envAfterErr := os.ReadFile(RcloneEnvPath(home))
	envChanged := envBeforeErr != nil || envAfterErr != nil || !bytes.Equal(envBefore, envAfter)
	item := []byte(LoginItem(goos, p))
	writes := []mountWrite{
		{p.ConfigPath, []byte(RcloneConfig(c)), 0o600},
		{itemPath, item, itemMode},
		{prefetchPath, prefetchItem, 0o644},
	}
	if err := os.MkdirAll(p.MountDir, 0o755); err != nil {
		return failDetail("drive-folder", err, p.MountDir)
	}
	// A folder that is already a mount holds the drive itself, not stray
	// local files, so nothing is moved out of it.
	var holding string
	var strays []string
	if on, _ := MountedDir(goos, p.MountDir); !on {
		var err error
		holding, strays, err = parkStrayMountFiles(p.MountDir)
		if err != nil {
			return err
		}
	} else if err := reclaimStrayHoldings(p.MountDir); err != nil {
		// A holding folder an earlier run could not empty goes into the
		// drive that is up now.
		fmt.Fprintf(os.Stderr, "note: local files beside %s could not be copied into the drive (%v); copy them by hand\n", p.MountDir, err)
	}
	if len(strays) > 0 {
		fmt.Fprintf(os.Stderr, "note: %s already had local files; they were moved to %s so the drive can mount, and they will be copied into the drive once it is up\n", p.MountDir, holding)
	}
	placed := false
	defer func() {
		if !placed && holding != "" {
			_ = restoreStrayMountFiles(holding, p.MountDir)
		}
	}()
	// The cache holds transient bytes by design: chunks up to the cache
	// cap, gone on the next sweep. Mark it from the first mount on so a
	// backup tool that walks the home folder (Time Machine, a Linux home
	// backup) skips it instead of burning the backup's quota on them
	// (issue #561). The tag is the standard one, so the tools that read
	// it recognize it, and it is rewritten identically on every mount.
	if err := writeCacheTag(p.CacheDir); err != nil {
		return err
	}
	// A re-run that would write exactly what is already on disk must not
	// restart the login item: a restart stops the running rclone, so it
	// unmounts a live drive under open files (issue #561). When nothing
	// changed and the drive is up, the run says so and leaves the mount
	// alone. A stopped drive still starts: an unchanged plan is not a
	// reason to leave a mount down.
	if !envChanged && mountWritesUnchanged(writes) {
		up, probeErr := mountState(goos, home)
		skipRestart := false
		switch {
		case probeErr != nil:
			// A probe that cannot answer is not an answer. A wedged FUSE
			// mount is exactly what makes the probe time out, and a restart
			// would unmount that live mount under open files, so an
			// inconclusive probe leaves the mount alone rather than risk it.
			fmt.Fprintf(os.Stderr, "note: could not check whether the drive is mounted (%v); leaving the mount alone\n", probeErr)
			skipRestart = true
		case up:
			fmt.Printf("Mount already running at %s\n", p.MountDir)
			skipRestart = true
		}
		if skipRestart {
			// The mount is up (or the probe could not say), but the prefetch
			// sidecar can still be down after a partial boot. Starting it is
			// idempotent and does not touch the mount.
			if err := startPrefetchLoginItem(goos, home, prefetchPath); err != nil {
				fmt.Fprintf(os.Stderr, "note: prefetch login item not started (%v); it is written at %s\n", err, prefetchPath)
			}
			excludeTransientFromBackup(goos, p)
			return nil
		}
	}
	for _, w := range writes {
		if err := WriteFileAtomic(w.path, w.data, w.mode); err != nil {
			return err
		}
	}
	if foreground {
		// The files go into the drive once it is up. If it never comes up,
		// they go back into the plain folder once rclone has exited, so a
		// failed mount does not leave them in the hidden holding folder.
		placed = true
		var once sync.Once
		restore := func() {
			once.Do(func() {
				if err := restoreStrayMountFiles(holding, p.MountDir); err != nil {
					fmt.Fprintf(os.Stderr, "note: local files at %s could not be copied into the drive (%v); copy them by hand from that folder\n", holding, err)
				}
			})
		}
		if holding != "" {
			go func() {
				if waitMounted(goos, home) == nil {
					restore()
				}
			}()
		}
		err := mountForeground(p, home)
		restore()
		return err
	}
	if err := startLoginItem(goos, p, itemPath); err != nil {
		return err
	}
	// Starting the login item is a request, not a promise: say the mount is up
	// only once the kernel says so, so a first run that silently failed is not
	// mistaken for a working drive.
	if err := waitMounted(goos, home); err != nil {
		return err
	}
	if err := restoreStrayMountFiles(holding, p.MountDir); err != nil {
		fmt.Fprintf(os.Stderr, "note: local files at %s could not be copied into the drive (%v); copy them by hand from that folder\n", holding, err)
	}
	placed = true
	if err := startPrefetchLoginItem(goos, home, prefetchPath); err != nil {
		fmt.Fprintf(os.Stderr, "note: prefetch login item not started (%v); it is written at %s\n", err, prefetchPath)
	}
	// The cache holds the mount's transient bytes (issue #561); keep macOS's
	// own backup tool off it. Everywhere else the CACHEDIR.TAG marker is the
	// signal a backup tool reads, so there is nothing to call here.
	excludeTransientFromBackup(goos, p)
	printMountedLine(p.MountDir)
	return nil
}

// mountWrite is one file a mount writes: where, what and with which
// mode. The same list decides whether a re-run changed anything and
// does the writing, so the two can never disagree about what a mount
// owns on disk.
type mountWrite struct {
	path string
	data []byte
	mode os.FileMode
}

// mountWritesUnchanged reports whether every file in writes is already
// on disk with exactly the bytes this run would write and the mode it
// would set. A re-run of `drive init` or `drive mount` with the same
// plan is the common case, and it is the case where restarting the
// login item would break open files (issue #561). A mode that drifted
// (the config and the login item carry the storage secret, so both are
// 0600) is a change too: the run repairs it.
func mountWritesUnchanged(writes []mountWrite) bool {
	for _, w := range writes {
		info, err := os.Stat(w.path)
		if err != nil || info.Mode().Perm() != w.mode.Perm() {
			return false
		}
		onDisk, err := os.ReadFile(w.path)
		if err != nil || !bytes.Equal(onDisk, w.data) {
			return false
		}
	}
	return true
}

// mountState reports whether the drive is mounted at the mount dir
// home holds. A var (the production value is Mounted) so a test can
// answer without a kernel mount: it is the check a re-run makes
// before it decides whether a restart is needed.
var mountState = Mounted

// waitProbe is the probe the wait for a just-started mount polls.
// The production value is Mounted; a var so a test can answer
// "up" without a kernel mount.
var waitProbe = Mounted

// startLoginItem starts the login item a mount just wrote: launchd
// bootstraps the plist into the session, and systemd daemon-reloads,
// enables and restarts the unit, falling back to a detached rclone
// when there is no user session to talk to. A var so a test can
// record the actions a mount takes instead of touching the machine's
// user manager.
var startLoginItem = startPlatformLoginItem

func startPlatformLoginItem(goos string, p MountPlan, itemPath string) error {
	if goos == "darwin" {
		if err := bootstrapLaunchd(itemPath); err != nil {
			return failDetail("login-item", err)
		}
		return nil
	}
	if err := startLinuxLoginItem(); err != nil {
		// A clean container and a first-run sandbox often have no systemd user
		// bus (drive#105): systemctl is missing, or it cannot reach the user
		// manager. Only that falls back to a detached rclone, because there is
		// no systemd to start the unit at login. A systemd host whose unit
		// fails to start (a bad unit, a full disk) is a named error, not a
		// fallback: a detached rclone there plus the unit still enabled would
		// mount a second rclone at the next login.
		if !systemdUserSessionAbsent(err) {
			return failDetail("login-item", err)
		}
		fmt.Fprintf(os.Stderr, "note: systemd user session is not available (%v); starting the mount in the background. The login item is at %s\n", err, itemPath)
		if err := startLinuxMountDetached(p); err != nil {
			return failDetail("mount-failed", err)
		}
	}
	return nil
}

// cacheDirTag is the standard cache-directory marker (the cache-dir
// convention backup and index tools read): a fixed signature line,
// then a comment naming what the directory is. The signature is the
// spec's own constant, so a tool that looks for CACHEDIR.TAG files
// finds this one.
const cacheDirTag = "Signature: 8a477f597d28d172769f0698c07c4e93\n" +
	"* This file is a cache directory tag. See https://bford.info/cachedir/ for information about cache directory systems that use it.\n"

// writeCacheTag marks the mount's cache dir as a cache (issue #561),
// on every platform, from the first mount on. It is idempotent: every
// mount writes the same bytes, and a backup tool that already read the
// tag reads the same answer again.
func writeCacheTag(cacheDir string) error {
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return failDetail("cache-tag", err, cacheDir)
	}
	if err := WriteFileAtomic(filepath.Join(cacheDir, "CACHEDIR.TAG"), []byte(cacheDirTag), 0o644); err != nil {
		return failDetail("cache-tag", err, cacheDir)
	}
	return nil
}

// excludeTransientFromBackup keeps macOS's own backup tool (Time
// Machine, which walks the home folder by default) off the mount's
// transient bytes (issue #561): the cache dir, whose chunks can fill
// the backup's quota. It is regenerable, so excluding it loses
// nothing. A refusal is a note, not a mount failure: the drive works
// without the exclusion, and the CACHEDIR.TAG marker still tells a
// tool that reads it. Everywhere but macOS there is no command to
// call, so the marker is the whole of it.
func excludeTransientFromBackup(goos string, p MountPlan) {
	if goos != "darwin" {
		return
	}
	if p.CacheDir == "" {
		return
	}
	if out, err := exec.Command("tmutil", "addexclusion", p.CacheDir).CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "note: could not exclude %s from Time Machine backups (%v): %s\n", p.CacheDir, err, out)
	}
}

// startLinuxLoginItem enables and restarts the systemd user unit this command
// just wrote. A missing user bus is a named error so the caller can start the
// mount in the background instead of reporting success with nothing mounted.
func startLinuxLoginItem() error {
	for _, action := range mountSystemctlActions() {
		args := []string{"--user", action}
		if action != "daemon-reload" {
			args = append(args, SystemdUnitName)
		}
		if err := exec.Command("systemctl", args...).Run(); err != nil {
			return fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
		}
	}
	return nil
}

// systemdUserSessionAbsent reports whether a startLinuxLoginItem error means
// there is no systemd user manager to start the login item with: systemctl is
// not installed, or it cannot reach the user bus. Every other systemctl
// failure (a unit that will not start, a full disk, a permission) is a real
// error the caller must see, not a reason to leave a detached mount behind.
func systemdUserSessionAbsent(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, absent := range []string{
		"executable file not found",    // systemctl is not installed
		"Failed to connect to bus",     // no user bus, no D-Bus session
		"not been booted with systemd", // no systemd user manager
		"XDG_RUNTIME_DIR not set",      // no user session to attach to
	} {
		if strings.Contains(msg, absent) {
			return true
		}
	}
	return false
}

// startLinuxMountDetached starts rclone in its own session so `drive init` can
// finish and exit while the mount stays up. rclone's own --log-file is already
// on the plan; stdout and stderr go there too so a container without journald
// still has the log.
func startLinuxMountDetached(p MountPlan) error {
	rclonePath, err := exec.LookPath(p.RcloneBin)
	if err != nil {
		return fmt.Errorf("rclone binary %q not found: %w", p.RcloneBin, err)
	}
	if err := os.MkdirAll(filepath.Dir(p.LogPath), 0o755); err != nil {
		return fmt.Errorf("create log dir: %w", err)
	}
	log, err := os.OpenFile(p.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open mount log %s: %w", p.LogPath, err)
	}
	defer log.Close()
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(rclonePath, p.Args()...)
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.Env = rcloneProcessEnv(p)
	cmd.SysProcAttr = detachedProcAttr()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("rclone mount: %w", err)
	}
	return nil
}

// mountForeground runs rclone in this process until it exits. rclonePath is
// resolved by ResolveRclone before the call, never from anything remote, and
// exec.Command takes an argument vector and runs no shell, so no remote or
// stored value can inject anything at this call site.
func mountForeground(p MountPlan, home string) error {
	rclonePath, err := exec.LookPath(p.RcloneBin)
	if err != nil {
		return failDetail("no-rclone", err)
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(rclonePath, p.Args()...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = rcloneProcessEnv(p)
	// Start the child first, so the signal handler below never sees a nil
	// Process: a SIGINT between Notify and Run would otherwise panic.
	if err := cmd.Start(); err != nil {
		return failDetail("mount-failed", fmt.Errorf("rclone mount: %w", err), p.LogPath)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if prefetchEnabled() {
		go runPrefetchLoop(ctx, p.MountDir)
	}
	// The background fill (issue #194) runs in this process for as long as the
	// mount does. It reaches the same rclone over the remote control the mount
	// already binds, so there is no second daemon, no listener of our own and
	// no file the fill keeps anywhere but rclone's capped VFS cache. It is
	// started after rclone is up and stopped with the mount, and every pass it
	// reports goes to the mount's log, so a fill problem is a named failure a
	// person can read rather than a silent no-op. It is also what keeps a file
	// or folder the person chose to keep offline (#115) in the cache, by
	// re-reading it on every pass so rclone's own eviction order takes from
	// the rest of the drive first.
	fillCtx, cancelFill := context.WithCancel(context.Background())
	go func() {
		// rclone's own remote control is not listening for the first moments
		// of the mount, so the loop's first pass waits for the mount to appear
		// (the same proof `drive mount` already makes) instead of racing it.
		_, _ = MountedDir(p.GOOS, p.MountDir)
		c := rcClientForMount(p)
		for err := range RunFillLoop(fillCtx, c, home, p.MountDir) {
			fmt.Fprintf(os.Stderr, "drive: background fill: %v\n", err)
		}
	}()
	// The conflict guard (issue #30) runs in this process for as long as the
	// mount does, on the same remote control: it watches this device's own
	// upload queue, hashes the bytes that could still be lost straight out of
	// the VFS cache, and when another device's save lands it writes the
	// conflict copy so both versions survive. The state path is where the
	// guard records how far behind it is, for `drive status`.
	conflictCtx, cancelConflict := context.WithCancel(context.Background())
	go func() {
		_, _ = MountedDir(p.GOOS, p.MountDir)
		// rcClientForMount carries the mount's own rc credentials (drive#498);
		// the guard's fourth argument is the state file it writes so `drive
		// status` can report how far behind the guard is (issue #569).
		c := rcClientForMount(p)
		for err := range RunConflictLoop(conflictCtx, p.Device, p.MountDir, p.CacheDir, p.Remote, ConflictGuardStatePath(home), c) {
			fmt.Fprintf(os.Stderr, "drive: conflict guard: %v\n", err)
		}
	}()
	// The live upload-queue report (drive issue #318) runs in this process for
	// as long as the mount does, on the same remote control: it reads the
	// queue rclone is holding (vfs/queue, core/stats, core/bwlimit) and reports
	// it to the api Worker over the device token this device already holds, so
	// the first-run and usage pages show the same numbers `drive status` prints.
	// It is started after rclone is up and stopped with the mount, and every
	// failed pass goes to the mount's log, so a report problem is a named
	// failure rather than a silent no-op.
	queueCtx, cancelQueue := context.WithCancel(context.Background())
	go func() {
		_, _ = MountedDir(p.GOOS, p.MountDir)
		c := rcClientForMount(p)
		for err := range RunQueueReportLoop(queueCtx, c, home) {
			fmt.Fprintf(os.Stderr, "drive: queue report: %v\n", err)
		}
	}()
	// Forward the usual stop signals to rclone so the mount is taken down
	// cleanly (rclone's own docs: SIGINT/SIGTERM unmount) instead of leaving a
	// mount attached behind a dead CLI. quit ends the goroutine once rclone is
	// gone, and joined is waited on so no handler outlives the mount.
	stop := make(chan os.Signal, 2)
	quit := make(chan struct{})
	joined := make(chan struct{})
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		defer close(joined)
		for {
			select {
			case sig := <-stop:
				_ = cmd.Process.Signal(sig)
			case <-quit:
				return
			}
		}
	}()
	runErr := cmd.Wait()
	cancel()
	signal.Stop(stop)
	close(quit)
	<-joined
	cancelFill()
	cancelConflict()
	cancelQueue()
	if runErr != nil {
		// rclone's own words are in its log, never on the terminal: the person
		// gets the table's what and the log path to read (drive#117).
		return failDetail("mount-failed", fmt.Errorf("rclone mount: %w", runErr), p.LogPath)
	}
	return nil
}

// printMountedLine ends a successful mount on one clear line (drive#117):
// where the drive is, and what to try first.
func printMountedLine(mountDir string) {
	fmt.Printf("Mounted at %s. Try: echo hello > %q\n", mountDir, filepath.Join(mountDir, "hello.txt"))
}

// waitMounted polls Mounted until the kernel reports the mount, then returns
// nil. The wait is never silent (drive#117): "Starting the mount" and a dot
// every half second stay on screen, so a first run that takes thirty seconds
// never looks hung.
func waitMounted(goos, home string) error {
	return waitMountedFor(goos, home, mountWait, 200*time.Millisecond, os.Stdout)
}

// waitMountedFor is waitMounted with the wait, the poll tick and the output
// injected, so the timeout and its words are testable in milliseconds.
func waitMountedFor(goos, home string, wait, tick time.Duration, out io.Writer) error {
	fmt.Fprint(out, "Starting the mount ")
	defer fmt.Fprintln(out)
	deadline := time.Now().Add(wait)
	shown := 0
	for time.Now().Before(deadline) {
		on, err := waitProbe(goos, home)
		if err != nil {
			return err
		}
		if on {
			return nil
		}
		time.Sleep(tick)
		shown++
		if shown%3 == 0 {
			fmt.Fprint(out, ".")
		}
	}
	return failDetail("mount-hung", nil, wait.String(), mountLogHint(goos, home))
}

// mountWait bounds the wait for a freshly started mount to appear.
const mountWait = 30 * time.Second

// mountLogHint is where to look when the mount did not come up: launchd and
// the Windows login task write rclone's output to the log path from the plan;
// on Linux the user journal owns a systemd unit's output.
func mountLogHint(goos, home string) string {
	if goos == "darwin" || goos == "windows" {
		return filepath.Join(DefaultConfigDir(home), "mount.log")
	}
	return "journalctl --user -u " + SystemdUnitName
}

// mountSystemctlActions is the ordered systemctl work a Linux mount does.
// `enable --now` is deliberately absent: it starts a stopped unit but leaves a
// running one alone, so a second `drive mount` with a different bucket,
// prefix, key or rclone path would report success while rclone still served the
// old one. `restart` applies the unit just written, every time.
func mountSystemctlActions() []string {
	return []string{"daemon-reload", "enable", "restart"}
}

// bootstrapLaunchd loads the login item with the current launchctl verbs.
// `load`/`unload -w` are deprecated and not idempotent (loading an item that
// is already loaded errors), so a loaded item is booted out first, then the
// item is bootstrapped into gui/<uid>, the session the person is logged into.
func bootstrapLaunchd(itemPath string) error {
	return bootstrapLaunchdLabel(LaunchdLabel, itemPath)
}

func bootstrapLaunchdLabel(label, itemPath string) error {
	target := launchctlTarget()
	if launchctlLoadedLabel(target, label) {
		if out, err := exec.Command("launchctl", launchctlArgvLabel(label, "bootout", target, itemPath)...).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl bootout %s: %w: %s", target, err, strings.TrimSpace(string(out)))
		}
	}
	if out, err := exec.Command("launchctl", launchctlArgvLabel(label, "bootstrap", target, itemPath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap %s %s: %w: %s", target, itemPath, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func bootoutLaunchd(itemPath string) error {
	return bootoutLaunchdLabel(LaunchdLabel, itemPath)
}

func bootoutLaunchdLabel(label, itemPath string) error {
	target := launchctlTarget()
	if !launchctlLoadedLabel(target, label) {
		return nil
	}
	if out, err := exec.Command("launchctl", launchctlArgvLabel(label, "bootout", target, itemPath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootout %s: %w: %s", target, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func launchctlTarget() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

func launchctlLoadedLabel(target, label string) bool {
	return exec.Command("launchctl", launchctlArgvLabel(label, "print", target, "")...).Run() == nil
}

func launchctlArgv(action, target, itemPath string) []string {
	return launchctlArgvLabel(LaunchdLabel, action, target, itemPath)
}

func launchctlArgvLabel(label, action, target, itemPath string) []string {
	switch action {
	case "print":
		return []string{"print", target + "/" + label}
	case "bootout":
		return []string{"bootout", target + "/" + label}
	case "bootstrap":
		return []string{"bootstrap", target, itemPath}
	}
	return nil
}

// RestartMount stops the mount and starts it again so rclone picks up a
// swapped storage key (core/cap.js `mount.restart`). The VFS cache is the
// uploads still waiting: nothing in this function deletes it, so a file
// queued before the cap was reached is still there when writes resume.
func RestartMount(goos, home, rcloneBin string, c StorageConfig) error {
	// On Windows the drive letter is chosen at mount time; read it from the
	// login task before Unmount removes it, so a restart keeps the same letter
	// instead of moving the person's drive.
	driveLetter := ""
	if goos == "windows" {
		if letter, err := windowsMountLetter(); err == nil {
			driveLetter = letter
		}
	}
	if err := Unmount(goos, home); err != nil {
		return err
	}
	return Mount(goos, home, rcloneBin, c, false, false, driveLetter)
}
func Unmount(goos, home string) error {
	if goos == "windows" {
		return unmountWindows(home)
	}
	if err := stopPrefetchLoginItem(goos, home); err != nil {
		fmt.Fprintf(os.Stderr, "note: could not disable the prefetch login item (%v)\n", err)
	}
	itemPath := LoginItemPath(goos, home)
	if _, err := os.Stat(itemPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return failDetail("unexpected", fmt.Errorf("stat %s: %w", itemPath, err))
	}
	if goos == "darwin" {
		return bootoutLaunchd(itemPath)
	}
	if err := exec.Command("systemctl", "--user", "disable", "--now", SystemdUnitName).Run(); err != nil {
		if stopErr := stopMount(goos, home); stopErr != nil {
			return failDetail("unexpected", fmt.Errorf("systemctl --user disable --now %s: %v; fusermount: %w", SystemdUnitName, err, stopErr))
		}
		// The mount is down but the login item could not be disabled, and only
		// uninstall and logout delete its file afterwards: a bare `drive
		// unmount` would otherwise report success while the unit starts again
		// at the next login. The error names the disable that failed.
		return failDetail("unexpected", fmt.Errorf("systemctl --user disable --now %s: %w", SystemdUnitName, err))
	}
	return nil
}

// Mounted reports whether MountDir has a live mount. Linux asks the kernel
// mount table through findmnt; macOS has no findmnt, so the BSD mount listing
// is the platform's own answer and its mount-point field is what is compared;
// Windows has neither, so the drive letter the login task names is the
// question asked of the volume table, through os.Stat.
func Mounted(goos, home string) (bool, error) {
	if goos == "windows" {
		letter, err := windowsMountLetter()
		if err != nil {
			return false, err
		}
		return windowsVolumeMounted(letter), nil
	}
	return MountedDir(goos, DefaultMountDir(home))
}

// MountedDir is Mounted for a mount point that is not <home>/Drive, so a caller
// holding the mount point itself (the proofs, whose dir may be a second mount
// on the same host) asks the same platform question. One switch, so a caller
// cannot drift from what `drive mount` waits on.
func MountedDir(goos, mountDir string) (bool, error) {
	// A FUSE mount whose backing store has gone away can block findmnt the
	// same way it blocks ReadDir (countEntries already bounds that). `drive
	// status` and `drive pause` both ask Mounted, so a wedged mount must
	// become a named timeout rather than a hung terminal.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	switch goos {
	case "darwin":
		out, err := exec.CommandContext(ctx, "mount").Output()
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return false, fmt.Errorf("mount: timed out")
			}
			return false, fmt.Errorf("mount: %w", err)
		}
		return bsdMountHasMountPoint(string(out), mountDir), nil
	case "windows":
		return windowsVolumeMounted(mountDir), nil
	default:
		out, err := exec.CommandContext(ctx, "findmnt", "-n", "-M", mountDir).Output()
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return false, fmt.Errorf("findmnt %s: timed out", mountDir)
			}
			if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
				return false, nil
			}
			return false, fmt.Errorf("findmnt %s: %w", mountDir, err)
		}
		return strings.TrimSpace(string(out)) != "", nil
	}
}

// bsdMountHasMountPoint reports whether a `mount` listing mounts dir. A line
// reads "<device> on <mount point> (<options>)"; the mount point may contain
// spaces (mount escapes them as backslash-040) and the options start after the
// last " (".
func bsdMountHasMountPoint(listing, dir string) bool {
	for _, line := range strings.Split(listing, "\n") {
		i := strings.Index(line, " on ")
		if i < 0 {
			continue
		}
		point := line[i+len(" on "):]
		if j := strings.LastIndex(point, " ("); j > 0 {
			point = point[:j]
		}
		if unescapeMountField(point) == dir {
			return true
		}
	}
	return false
}

// unescapeMountField undoes the octal escaping the BSD mount(8) listing uses
// for spaces, tabs and backslashes in a mount point.
func unescapeMountField(s string) string {
	return strings.NewReplacer(`\040`, " ", `\011`, "\t", `\134`, `\`).Replace(s)
}

// ResolveRclone turns the operator's rclone setting into an absolute binary
// path. The value comes from --rclone (or DRIVE_RCLONE) only; there is no file
// override. It is resolved with exec.LookPath here, before the path is written
// into a launchd plist or a systemd unit, because a login item has no shell
// PATH and a bare "rclone" (Homebrew installs it at /opt/homebrew/bin) would
// fail on the item's first run. An empty setting keeps whatever PATH resolves
// at call time; a named binary that is not installed fails now, at the person's
// own command, not silently at the next login.
func ResolveRclone(rclone string) (string, error) {
	if rclone == "" {
		rclone = os.Getenv("DRIVE_RCLONE")
	}
	if rclone == "" {
		path, err := exec.LookPath("rclone")
		if err != nil {
			return "", failDetail("no-rclone", err)
		}
		return absPath(path)
	}
	parent, err := exec.LookPath(rclone)
	if err != nil {
		return "", failDetail("no-rclone", fmt.Errorf("rclone binary %q not found", rclone))
	}
	return absPath(parent)
}

// absPath makes a LookPath result absolute. A relative PATH entry or an
// explicit `./rclone` yields a relative result from LookPath: it only works
// from one working directory, and a login item is not started from one, so
// the value written into the plist or the unit must be absolute.
func absPath(p string) (string, error) {
	if filepath.IsAbs(p) {
		return p, nil
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", p, err)
	}
	return abs, nil
}

// CurrentGOOS is split out so tests can inject a platform.
func CurrentGOOS() string { return runtime.GOOS }
