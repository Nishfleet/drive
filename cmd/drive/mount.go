package main

import (
	"errors"
	"fmt"
	"html"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// MountPlan is everything needed to mount this device's drive with stock
// rclone. The remote is the device's own S3 bucket path; the endpoint and keys
// live in the rclone config this CLI writes, so the same plan works against the
// local S3 stand-in and against the real storage (step 1) with no code change.
type MountPlan struct {
	GOOS       string
	RcloneBin  string
	Subcommand string // "nfsmount" on macOS, "mount" on Linux
	Remote     string // drive:<bucket>/<prefix>
	MountDir   string
	ConfigPath string
	CacheDir   string
	LogPath    string
	VFSArgs    []string
}

// VFSArgs are the stock rclone VFS flags this product mounts with. The docs
// for rclone's mount command describe each one.
func VFSArgs() []string {
	return []string{
		"--vfs-cache-mode", vfsCacheModeValue,
		"--vfs-write-back", vfsWriteBackValue,
		"--vfs-cache-max-size", vfsCacheMaxValue,
		"--vfs-read-chunk-streams", "2",
		"--buffer-size", vfsChunkStreamSize,
	}
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
// that knows nfsmount is the macOS command and mount is the Linux one.
func BuildMountPlan(goos, home, rcloneBin string, c StorageConfig) MountPlan {
	sub := "mount"
	if goos == "darwin" {
		sub = "nfsmount"
	}
	return MountPlan{
		GOOS:       goos,
		RcloneBin:  rcloneBin,
		Subcommand: sub,
		Remote:     RemoteFor(c),
		MountDir:   DefaultMountDir(home),
		ConfigPath: RcloneConfigPath(home),
		CacheDir:   DefaultCacheDir(home),
		LogPath:    filepath.Join(DefaultConfigDir(home), "mount.log"),
		VFSArgs:    VFSArgs(),
	}
}

// Args is the full rclone argument vector, in the order the docs show.
func (p MountPlan) Args() []string {
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
	)
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
ExecStart=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, p.Remote, systemdCommandLine(p))
}

// systemdCommandLine renders the rclone argument vector the way systemd reads
// it, not the way a shell would: systemd has its own quoting rules for
// ExecStart (double quotes with backslash and quote escaped, and every percent
// doubled for its %-specifier expansion). CommandLine stays shell-shaped for
// human display only.
func systemdCommandLine(p MountPlan) string {
	parts := append([]string{p.RcloneBin}, p.Args()...)
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

// LoginItemPath is where the login item for goos is written.
func LoginItemPath(goos, home string) string {
	if goos == "darwin" {
		return LaunchdPlistPath(home)
	}
	return SystemdUnitPath(home)
}

// LoginItem renders the login item for goos.
func LoginItem(goos string, p MountPlan) string {
	if goos == "darwin" {
		return LaunchdPlist(p)
	}
	return SystemdUnit(p)
}

// Mount writes the rclone config and the login item, then starts the mount.
// foreground runs rclone in this process (used by the proof and by debugging);
// otherwise the login item starts it (launchd on macOS, systemd on Linux).
func Mount(goos, home, rcloneBin string, c StorageConfig, foreground, dryRun bool) error {
	p := BuildMountPlan(goos, home, rcloneBin, c)
	item := []byte(LoginItem(goos, p))
	itemPath := LoginItemPath(goos, home)
	// The mount dir is created only once the plan is real: --dry-run writes
	// nothing at all, and prints the config with both keys redacted.
	if dryRun {
		fmt.Printf("--- %s ---\n%s", p.ConfigPath, RcloneConfigRedacted(c))
		fmt.Printf("--- %s ---\n%s", itemPath, item)
		fmt.Printf("--- would run ---\n%s\n", p.CommandLine())
		return nil
	}
	if err := os.MkdirAll(p.MountDir, 0o755); err != nil {
		return fmt.Errorf("create mount dir %s: %w", p.MountDir, err)
	}
	config := []byte(RcloneConfig(c))
	if err := WriteFileAtomic(p.ConfigPath, config, 0o600); err != nil {
		return err
	}
	if err := WriteFileAtomic(itemPath, item, 0o644); err != nil {
		return err
	}
	if foreground {
		return mountForeground(p)
	}
	if goos == "darwin" {
		if err := bootstrapLaunchd(itemPath); err != nil {
			return err
		}
	} else {
		if err := exec.Command("systemctl", "--user", "daemon-reload").Run(); err != nil {
			return fmt.Errorf("systemctl --user daemon-reload: %w", err)
		}
		if err := exec.Command("systemctl", "--user", "enable", "--now", SystemdUnitName).Run(); err != nil {
			return fmt.Errorf("systemctl --user enable --now %s: %w", SystemdUnitName, err)
		}
	}
	// Starting the login item is a request, not a promise: say the mount is up
	// only once the kernel says so, so a first run that silently failed is not
	// mistaken for a working drive.
	if err := waitMounted(goos, home); err != nil {
		return err
	}
	fmt.Printf("Mounted at %s\n", p.MountDir)
	return nil
}

// mountForeground runs rclone in this process until it exits. rclonePath is
// resolved by ResolveRclone before the call, never from anything remote, and
// exec.Command takes an argument vector and runs no shell, so no remote or
// stored value can inject anything at this call site.
func mountForeground(p MountPlan) error {
	rclonePath, err := exec.LookPath(p.RcloneBin)
	if err != nil {
		return fmt.Errorf("rclone binary %q not found: %w", p.RcloneBin, err)
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(rclonePath, p.Args()...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// Forward the usual stop signals to rclone so the mount is taken down
	// cleanly (rclone's own docs: SIGINT/SIGTERM unmount) instead of leaving a
	// mount attached behind a dead CLI.
	stop := make(chan os.Signal, 2)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer func() { signal.Stop(stop) }()
	go func() {
		for sig := range stop {
			_ = cmd.Process.Signal(sig)
		}
	}()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("rclone mount: %w", err)
	}
	return nil
}

// waitMounted polls Mounted until the kernel reports the mount, then returns
// nil. A mount that never appears is a named failure with the command that was
// started, not a success with a warning.
func waitMounted(goos, home string) error {
	deadline := time.Now().Add(mountWait)
	for time.Now().Before(deadline) {
		on, err := Mounted(goos, home)
		if err != nil {
			return err
		}
		if on {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("the mount did not come up within %s; check the login item and %s",
		mountWait, filepath.Join(DefaultConfigDir(home), "mount.log"))
}

// mountWait bounds the wait for a freshly started mount to appear.
const mountWait = 30 * time.Second

// bootstrapLaunchd loads the login item with the current launchctl verbs.
// `load`/`unload -w` are deprecated and not idempotent (loading an item that
// is already loaded errors), so a loaded item is booted out first, then the
// item is bootstrapped into gui/<uid>, the session the person is logged into.
func bootstrapLaunchd(itemPath string) error {
	target := launchctlTarget()
	if launchctlLoaded(target) {
		if out, err := exec.Command("launchctl", launchctlArgv("bootout", target, itemPath)...).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl bootout %s: %w: %s", target, err, strings.TrimSpace(string(out)))
		}
	}
	if out, err := exec.Command("launchctl", launchctlArgv("bootstrap", target, itemPath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap %s %s: %w: %s", target, itemPath, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// bootoutLaunchd stops the login item with the current launchctl verb. An item
// that is not loaded is already stopped, so bootout does not run.
func bootoutLaunchd(itemPath string) error {
	target := launchctlTarget()
	if !launchctlLoaded(target) {
		return nil
	}
	if out, err := exec.Command("launchctl", launchctlArgv("bootout", target, itemPath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootout %s: %w: %s", target, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// launchctlTarget is the launchd domain a login item lives in: gui/<uid>, the
// session the person is logged into.
func launchctlTarget() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

// launchctlLoaded asks launchd whether the service is loaded. `launchctl
// print` exits non-zero when it is not, which is exactly the question; the
// answer only decides whether a bootout runs, so nothing else is read from it.
func launchctlLoaded(target string) bool {
	return exec.Command("launchctl", launchctlArgv("print", target, "")...).Run() == nil
}

// launchctlArgv is the launchctl command line for one action, kept separate so
// the deprecated load/unload verbs cannot creep back in unnoticed. print and
// bootout address the service by domain/label; bootstrap takes the domain and
// then the plist to load.
func launchctlArgv(action, target, itemPath string) []string {
	switch action {
	case "print":
		return []string{"print", target + "/" + LaunchdLabel}
	case "bootout":
		return []string{"bootout", target + "/" + LaunchdLabel}
	case "bootstrap":
		return []string{"bootstrap", target, itemPath}
	}
	return nil
}

// Unmount stops the mount and the login item. Running it twice is not an
// error: an absent login item means the drive is already stopped.
func Unmount(goos, home string) error {
	itemPath := LoginItemPath(goos, home)
	if _, err := os.Stat(itemPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", itemPath, err)
	}
	if goos == "darwin" {
		return bootoutLaunchd(itemPath)
	}
	if err := exec.Command("systemctl", "--user", "disable", "--now", SystemdUnitName).Run(); err != nil {
		return fmt.Errorf("systemctl --user disable --now %s: %w", SystemdUnitName, err)
	}
	return nil
}

// Mounted reports whether MountDir has a live mount. Linux asks the kernel
// mount table through findmnt; macOS has no findmnt, so the BSD mount listing
// is the platform's own answer and its mount-point field is what is compared.
func Mounted(goos, home string) (bool, error) {
	mountDir := DefaultMountDir(home)
	if goos == "darwin" {
		out, err := exec.Command("mount").Output()
		if err != nil {
			return false, fmt.Errorf("mount: %w", err)
		}
		return bsdMountHasMountPoint(string(out), mountDir), nil
	}
	out, err := exec.Command("findmnt", "-n", "-M", mountDir).Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
			return false, nil
		}
		return false, fmt.Errorf("findmnt %s: %w", mountDir, err)
	}
	return strings.TrimSpace(string(out)) != "", nil
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
			return "", fmt.Errorf("rclone not found on PATH: %w", err)
		}
		return path, nil
	}
	path, err := exec.LookPath(rclone)
	if err != nil {
		return "", fmt.Errorf("rclone binary %q not found: %w", rclone, err)
	}
	return path, nil
}

// CurrentGOOS is split out so tests can inject a platform.
func CurrentGOOS() string { return runtime.GOOS }
