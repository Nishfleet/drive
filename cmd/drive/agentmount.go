package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	agentRootDirName = "Drive-agents"
)

// AgentRootDir is the directory holding one path per connected agent tool.
func AgentRootDir(home string) string {
	return filepath.Join(home, agentRootDirName)
}

// AgentMountDir is the agent path tool works in: its own mount, backed by its own key, a sibling of the person's `~/Drive`.
func AgentMountDir(home, tool string) string {
	return filepath.Join(AgentRootDir(home), toolNameInPath(tool))
}

// AgentRcloneConfigPath is the rclone config one tool's agent mount reads.
func AgentRcloneConfigPath(home, tool string) string {
	return filepath.Join(DefaultConfigDir(home), "agent-"+toolNameInPath(tool)+"-rclone.conf")
}

// AgentRcloneEnvPath is the 0600 env file holding one tool's agent secret, named for the tool for the same reason as the config file.
func AgentRcloneEnvPath(home, tool string) string {
	return filepath.Join(DefaultConfigDir(home), "agent-"+toolNameInPath(tool)+"-rclone.env")
}

// AgentLogPath is the log for one tool's agent mount.
func AgentLogPath(home, tool string) string {
	return filepath.Join(DefaultConfigDir(home), "agent-"+toolNameInPath(tool)+".log")
}

// AgentCacheDir is the VFS cache for one tool's agent mount.
func AgentCacheDir(home, tool string) string {
	return filepath.Join(home, ".cache", "drive", "agents", toolNameInPath(tool), "vfs")
}

// AgentSystemdUnitName is the Linux login unit for one tool's agent mount.
func AgentSystemdUnitName(tool string) string {
	return "drive-agent-" + toolNameInPath(tool) + ".service"
}

// AgentLaunchdLabel is the macOS login item label for one tool's agent mount.
func AgentLaunchdLabel(tool string) string {
	return LaunchdLabel + ".agent." + toolNameInPath(tool)
}

// AgentLoginItemPath is where the agent mount's login item is written.
func AgentLoginItemPath(goos, home, tool string) string {
	switch goos {
	case "darwin":
		return filepath.Join(filepath.Dir(LaunchdPlistPath(home)),
			AgentLaunchdLabel(tool)+".plist")
	case "windows":
		return ""
	default:
		return filepath.Join(filepath.Dir(SystemdUnitPath(home)), AgentSystemdUnitName(tool))
	}
}

// AgentLoginItem renders the agent mount's login item for goos.
func AgentLoginItem(goos string, p MountPlan, tool string) string {
	switch goos {
	case "darwin":
		return LaunchdPlistFor(p, AgentLaunchdLabel(tool))
	default:
		return SystemdUnit(p)
	}
}

func toolNameInPath(tool string) string {
	safe := make([]rune, 0, len(tool))
	for _, r := range strings.ToLower(tool) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			safe = append(safe, r)
		default:
			safe = append(safe, '-')
		}
	}
	return strings.Trim(string(safe), "-")
}

// AgentMountConfig is the agent mount's storage settings: the device mount's own shared settings (endpoint, bucket, region, the download host that counts an agent's read as a read) with the tool's own credential and prefix in place of the person's.
func AgentMountConfig(device StorageConfig, key agentKey) StorageConfig {
	c := device
	c.AccessKey = key.AccessKeyID
	c.SecretKey = key.Secret
	c.SessionToken = key.SessionToken
	c.Bucket = firstNonEmpty(key.Bucket, device.Bucket)
	c.Prefix = key.Prefix
	c.Region = firstNonEmpty(key.Region, device.Region)
	c.Endpoint = firstNonEmpty(key.Endpoint, device.Endpoint)
	return c
}

// BuildAgentMountPlan is BuildMountPlan for one tool's agent path.
func BuildAgentMountPlan(goos, home, rcloneBin string, tool string, c StorageConfig) MountPlan {
	p := MountPlan{
		GOOS:      goos,
		RcloneBin: rcloneBin,
		Subcommand: func() string {
			if goos == "windows" {
				return "nfsmount"
			}
			return "mount"
		}(),
		Remote:      RemoteFor(c),
		MountDir:    AgentMountDir(home, tool),
		ConfigPath:  AgentRcloneConfigPath(home, tool),
		EnvPath:     AgentRcloneEnvPath(home, tool),
		CacheDir:    AgentCacheDir(home, tool),
		CacheMax:    vfsCacheMaxValue,
		LogPath:     AgentLogPath(home, tool),
		Bwlimit:     "",
		RCAddr:      "",
		SecretKey:   c.SecretKey,
		DownloadURL: c.DownloadURL,
	}
	if c.Bucket == "" || c.AccessKey == "" || c.Endpoint == "" || c.Prefix == "" {
		p.err = failf("agent-key-missing", tool)
		return p
	}
	if goos == "windows" {
		p.err = failf("agent-path-windows", tool)
		return p
	}
	return p
}

func mountAgentPaths(goos, home, rcloneBin, tool string, device StorageConfig, key agentKey, foreground bool) error {
	p := BuildAgentMountPlan(goos, home, rcloneBin, tool, AgentMountConfig(device, key))
	if p.err != nil {
		return p.err
	}
	if err := os.MkdirAll(p.MountDir, 0o755); err != nil {
		return failDetail("mount-failed", err)
	}
	if err := os.MkdirAll(filepath.Dir(p.ConfigPath), 0o700); err != nil {
		return failDetail("mount-failed", err)
	}
	if err := WriteFileAtomic(p.ConfigPath, []byte(RcloneConfig(AgentMountConfig(device, key))), 0o600); err != nil {
		return failDetail("mount-failed", err)
	}
	if err := WriteFileAtomic(AgentRcloneEnvPath(home, tool), []byte(agentRcloneEnv(AgentMountConfig(device, key))), 0o600); err != nil {
		return failDetail("mount-failed", err)
	}
	itemPath := AgentLoginItemPath(goos, home, tool)
	if err := WriteFileAtomic(itemPath, []byte(AgentLoginItem(goos, p, tool)), 0o600); err != nil {
		return failDetail("mount-failed", err)
	}
	if foreground {
		return mountAgentForeground(p)
	}
	if err := startAgentLoginItem(goos, home, p, tool); err != nil {
		return err
	}
	if err := waitAgentMounted(goos, p); err != nil {
		return err
	}
	fmt.Printf("Agent path for %s mounted at %s.\n", tool, p.MountDir)
	return nil
}

func agentRcloneEnv(c StorageConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s=%s\n", rcloneSecretEnv, systemdEnvQuote(c.SecretKey))
	if c.SessionToken != "" {
		fmt.Fprintf(&b, "RCLONE_CONFIG_DRIVE_SESSION_TOKEN=%s\n", c.SessionToken)
	}
	return b.String()
}

func mountAgentForeground(p MountPlan) error {
	rclonePath, err := exec.LookPath(p.RcloneBin)
	if err != nil {
		return failDetail("no-rclone", err)
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(rclonePath, p.loginItemArgs()...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = rcloneProcessEnv(p)
	return cmd.Run()
}

func startAgentLoginItem(goos, home string, p MountPlan, tool string) error {
	if goos == "darwin" {
		if err := bootstrapLaunchdLabel(AgentLaunchdLabel(tool), AgentLoginItemPath(goos, home, tool)); err != nil {
			return failDetail("login-item", err)
		}
		return nil
	}
	unit := AgentSystemdUnitName(tool)
	for _, action := range mountSystemctlActions() {
		args := []string{"--user", action}
		if action != "daemon-reload" {
			args = append(args, unit)
		}
		if err := exec.Command("systemctl", args...).Run(); err != nil {
			err = fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
			if !systemdUserSessionAbsent(err) {
				return failDetail("login-item", err)
			}
			fmt.Fprintf(os.Stderr, "note: systemd user session is not available (%v); starting the agent path in the background.\n", err)
			return startLinuxMountDetached(p)
		}
	}
	return nil
}

func waitAgentMounted(goos string, p MountPlan) error {
	deadline := time.Now().Add(mountWaitTimeout)
	for {
		up, err := MountedDir(goos, p.MountDir)
		if err == nil && up {
			return nil
		}
		if time.Now().After(deadline) {
			return failf("agent-path-timeout", p.MountDir, agentMountTimeoutSeconds, p.LogPath)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// UnmountAgent stops one tool's agent mount: the login item first, then the mount itself if the item was already gone.
func UnmountAgent(goos, home, tool string) error {
	if goos == "windows" {
		return nil
	}
	itemPath := AgentLoginItemPath(goos, home, tool)
	if _, err := os.Stat(itemPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return unmountAgentDir(goos, AgentMountDir(home, tool))
		}
		return failDetail("unexpected", fmt.Errorf("stat %s: %w", itemPath, err))
	}
	if goos == "darwin" {
		if err := bootoutLaunchdLabel(AgentLaunchdLabel(tool), itemPath); err != nil {
			return failDetail("unexpected", err)
		}
	} else if err := exec.Command("systemctl", "--user", "disable", "--now", AgentSystemdUnitName(tool)).Run(); err != nil {
		if systemdUserSessionAbsent(err) {
			if stopErr := unmountAgentDir(goos, AgentMountDir(home, tool)); stopErr != nil {
				return failDetail("unexpected", fmt.Errorf("systemctl --user disable --now %s: %v; fusermount: %w", AgentSystemdUnitName(tool), err, stopErr))
			}
			_ = os.Remove(itemPath)
			return nil
		}
		if stopErr := unmountAgentDir(goos, AgentMountDir(home, tool)); stopErr != nil {
			return failDetail("unexpected", fmt.Errorf("systemctl --user disable --now %s: %v; fusermount: %w", AgentSystemdUnitName(tool), err, stopErr))
		}
		return failDetail("unexpected", fmt.Errorf("systemctl --user disable --now %s: %w", AgentSystemdUnitName(tool), err))
	}
	_ = os.Remove(itemPath)
	return nil
}

func unmountAgentDir(goos, mountDir string) error {
	if mounted, err := MountedDir(goos, mountDir); err != nil || !mounted {
		return nil
	}
	if goos == "darwin" {
		if err := runUmount(mountDir); err != nil {
			return failDetail("unexpected", fmt.Errorf("unmount %s: %w", mountDir, err))
		}
		return nil
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount3"; the only argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	if err := exec.Command("fusermount3", "-u", mountDir).Run(); err == nil {
		return nil
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "fusermount"; the only argument is the mount dir derived from --home; exec.Command takes an argument vector, not a shell.
	if err := exec.Command("fusermount", "-u", mountDir).Run(); err == nil {
		return nil
	}
	return failDetail("unexpected", fmt.Errorf("unmount %s: no fuse unmount succeeded", mountDir))
}

// AgentMounted reports whether tool's agent path is a live mount.
func AgentMounted(goos, home, tool string) (bool, error) {
	if goos == "windows" {
		return false, nil
	}
	return MountedDir(goos, AgentMountDir(home, tool))
}

// AgentPathState is what `drive agents` reports about one tool's path: the mount point, whether it is live, and whether its login item is installed.
type AgentPathState struct {
	Tool      string
	Path      string
	Mounted   bool
	LoginItem bool
}

// AgentPathStates lists every connected tool's agent path, so `drive agents` can show the path each one really works in instead of a promise.
func AgentPathStates(goos, home string, tools []string) []AgentPathState {
	states := make([]AgentPathState, 0, len(tools))
	for _, tool := range tools {
		state := AgentPathState{Tool: tool, Path: AgentMountDir(home, tool)}
		if goos == "windows" {
			states = append(states, state)
			continue
		}
		if mounted, err := MountedDir(goos, state.Path); err == nil {
			state.Mounted = mounted
		}
		if _, err := os.Stat(AgentLoginItemPath(goos, home, tool)); err == nil {
			state.LoginItem = true
		}
		states = append(states, state)
	}
	return states
}

// AgentPathSummary is one line of `drive agents` output: the path, and whether it is up.
func AgentPathSummary(s AgentPathState) string {
	switch {
	case s.Mounted:
		return "agent path: " + s.Path + " (mounted)"
	case s.LoginItem:
		return "agent path: " + s.Path + " (not running)"
	default:
		return "agent path: not set up"
	}
}

const agentMountTimeoutSeconds = "60"

var mountWaitTimeout = 60 * time.Second
