package main

import (
	"fmt"
	"html"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
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
func SystemdUnit(p MountPlan) string {
	return fmt.Sprintf(`[Unit]
Description=drive: %s mounted with stock rclone
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=%s
ExecStop=%s umount %s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, p.Remote, p.CommandLine(), p.RcloneBin, p.MountDir)
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
	if err := os.MkdirAll(p.MountDir, 0o755); err != nil {
		return fmt.Errorf("create mount dir %s: %w", p.MountDir, err)
	}
	config := []byte(RcloneConfig(c))
	item := []byte(LoginItem(goos, p))
	itemPath := LoginItemPath(goos, home)
	if dryRun {
		fmt.Printf("--- %s ---\n%s", p.ConfigPath, config)
		fmt.Printf("--- %s ---\n%s", itemPath, item)
		fmt.Printf("--- would run ---\n%s\n", p.CommandLine())
		return nil
	}
	if err := WriteFileAtomic(p.ConfigPath, config, 0o600); err != nil {
		return err
	}
	if err := WriteFileAtomic(itemPath, item, 0o644); err != nil {
		return err
	}
	if foreground {
		cmd := exec.Command(rcloneBin, p.Args()...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		// Forward the usual stop signals to rclone so the mount is taken down
		// cleanly (rclone's own docs: SIGINT/SIGTERM unmount) instead of
		// leaving a mount attached behind a dead CLI.
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
	if goos == "darwin" {
		if err := exec.Command("launchctl", "load", "-w", itemPath).Run(); err != nil {
			return fmt.Errorf("launchctl load %s: %w", itemPath, err)
		}
		return nil
	}
	if err := exec.Command("systemctl", "--user", "daemon-reload").Run(); err != nil {
		return fmt.Errorf("systemctl --user daemon-reload: %w", err)
	}
	if err := exec.Command("systemctl", "--user", "enable", "--now", SystemdUnitName).Run(); err != nil {
		return fmt.Errorf("systemctl --user enable --now %s: %w", SystemdUnitName, err)
	}
	return nil
}

// Unmount stops the mount and the login item.
func Unmount(goos, home string) error {
	if goos == "darwin" {
		itemPath := LaunchdPlistPath(home)
		if err := exec.Command("launchctl", "unload", "-w", itemPath).Run(); err != nil {
			return fmt.Errorf("launchctl unload %s: %w", itemPath, err)
		}
		return nil
	}
	if err := exec.Command("systemctl", "--user", "disable", "--now", SystemdUnitName).Run(); err != nil {
		return fmt.Errorf("systemctl --user disable --now %s: %w", SystemdUnitName, err)
	}
	return nil
}

// Mounted reports whether MountDir has a live mount. On Linux it asks the
// kernel mount table; a plain directory that is not a mount point is unmounted.
func Mounted(goos, home string) (bool, error) {
	mountDir := DefaultMountDir(home)
	out, err := exec.Command("findmnt", "-n", "-M", mountDir).Output()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
			return false, nil
		}
		return false, fmt.Errorf("findmnt %s: %w", mountDir, err)
	}
	return strings.TrimSpace(string(out)) != "", nil
}

// DefaultRcloneBin returns an explicit rclone path when the operator set one,
// otherwise the bare name resolved from PATH at run time.
func DefaultRcloneBin(home string) string {
	if v := os.Getenv("DRIVE_RCLONE"); v != "" {
		return v
	}
	if data, err := os.ReadFile(RcloneBinOverride(home)); err == nil {
		if p := strings.TrimSpace(string(data)); p != "" {
			return p
		}
	}
	return "rclone"
}

// CurrentGOOS is split out so tests can inject a platform.
func CurrentGOOS() string { return runtime.GOOS }
