package main

import (
	"context"
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
	// DownloadURL is the dl Worker (drive issue #58, build step 5), empty
	// when none is configured. It is a mount argument, not a line in the
	// rclone config the user owns: rclone streams every read through the
	// host, and the host counts the bytes, so a mount that did not point at
	// it would serve reads nobody bills.
	DownloadURL string
}

// VFSArgs are the stock rclone VFS flags this product mounts with. The docs
// for rclone's mount and nfsmount commands describe each one.
func VFSArgs() []string {
	return []string{
		"--vfs-cache-mode", vfsCacheModeValue,
		"--vfs-write-back", vfsWriteBackValue,
		"--vfs-cache-max-size", vfsCacheMaxValue,
		// S3 sends no change notifications, so without a short directory cache
		// a save made on the other machine waits out rclone's 5-minute default
		// before it is visible here. The step-3 two-machine proof measured it
		// against a local S3 stand-in (issue #62, PR #61): about 5 s with the
		// flag, still absent after 60 s without.
		"--dir-cache-time", vfsDirCacheTimeValue,
		"--vfs-read-chunk-streams", "2",
		"--buffer-size", vfsChunkStreamSize,
		// --vfs-read-ahead is the stock flag that covers "the first chunk of a
		// file already being read" with --vfs-cache-mode full. It does not
		// prefetch child listings when a folder is listed; that has no flag
		// (rclone's --vfs-refresh walks the whole tree at mount start, which
		// is the wrong trigger and delays mount-ready), so drive prefetch
		// does only that leftover work.
		"--vfs-read-ahead", vfsReadAheadValue,
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
		GOOS:        goos,
		RcloneBin:   rcloneBin,
		Subcommand:  sub,
		Remote:      RemoteFor(c),
		MountDir:    DefaultMountDir(home),
		ConfigPath:  RcloneConfigPath(home),
		CacheDir:    DefaultCacheDir(home),
		LogPath:     filepath.Join(DefaultConfigDir(home), "mount.log"),
		VFSArgs:     VFSArgs(),
		DownloadURL: c.DownloadURL,
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
	// The download host, when one is configured (issue #58). It is the S3
	// provider's own flag --s3-download-url, the one rclone's docs list for
	// "tell the backend where downloads can be fetched from", so reads on the
	// mount go to the dl Worker and are counted. With none configured the
	// mount reads from the endpoint itself and no flag is passed: rclone
	// errors on an empty value, and an uncounted read is already the state of
	// a local stand-in.
	if p.DownloadURL != "" {
		args = append(args, "--s3-download-url", p.DownloadURL)
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
	driveBin, exeErr := os.Executable()
	if exeErr != nil {
		return fmt.Errorf("resolve drive binary: %w", exeErr)
	}
	prefetchItem := []byte(PrefetchLoginItem(goos, driveBin, home))
	prefetchPath := PrefetchLoginItemPath(goos, home)
	if dryRun {
		fmt.Printf("--- %s ---\n%s", p.ConfigPath, RcloneConfigRedacted(c))
		fmt.Printf("--- %s ---\n%s", itemPath, item)
		fmt.Printf("--- %s ---\n%s", prefetchPath, prefetchItem)
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
	if err := WriteFileAtomic(prefetchPath, prefetchItem, 0o644); err != nil {
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
		for _, action := range mountSystemctlActions() {
			args := []string{"--user", action}
			if action != "daemon-reload" {
				args = append(args, SystemdUnitName)
			}
			if err := exec.Command("systemctl", args...).Run(); err != nil {
				return fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
			}
		}
	}
	// Starting the login item is a request, not a promise: say the mount is up
	// only once the kernel says so, so a first run that silently failed is not
	// mistaken for a working drive.
	if err := waitMounted(goos, home); err != nil {
		return err
	}
	if err := startPrefetchLoginItem(goos, home, prefetchPath); err != nil {
		return fmt.Errorf("start prefetch: %w", err)
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
	// Start the child first, so the signal handler below never sees a nil
	// Process: a SIGINT between Notify and Run would otherwise panic.
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("rclone mount: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if prefetchEnabled() {
		go runPrefetchLoop(ctx, p.MountDir)
	}
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
	signal.Stop(stop)
	close(quit)
	<-joined
	if runErr != nil {
		return fmt.Errorf("rclone mount: %w", runErr)
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
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("the mount did not come up within %s; check the login item and %s",
		mountWait, mountLogHint(goos, home))
}

// mountWait bounds the wait for a freshly started mount to appear.
const mountWait = 30 * time.Second

// mountLogHint is where to look when the mount did not come up: launchd
// writes the item's output to the log path from the plan; on Linux the user
// journal owns a systemd unit's output.
func mountLogHint(goos, home string) string {
	if goos == "darwin" {
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

func launchctlLoaded(target string) bool {
	return launchctlLoadedLabel(target, LaunchdLabel)
}

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

// Unmount stops the mount and the login item. Running it twice is not an
// error: an absent login item means the drive is already stopped.
func Unmount(goos, home string) error {
	if err := stopPrefetchLoginItem(goos, home); err != nil {
		return err
	}
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
		return absPath(path)
	}
	parent, err := exec.LookPath(rclone)
	if err != nil {
		return "", fmt.Errorf("rclone binary %q not found: %w", rclone, err)
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
