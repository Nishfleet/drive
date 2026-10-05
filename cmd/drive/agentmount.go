package main

// The agent path (drive issue #514): the folder an agent tool actually works
// in. It is a second rclone mount, and the credential behind it is that tool's
// own key — the one that has no `deleteFiles`, minted for the tool by
// `drive agents connect`.
//
// Why a mount of its own rather than the person's mount: the MCP filesystem
// server and the agent's shell both read plain files through the kernel, and
// the kernel will serve them whatever credential rclone holds. A mount that
// holds the device key deletes, so an agent given `~/Drive` deletes. Storage
// enforcement is the only place a no-delete key can bite without asking each
// tool to honour it, and storage only sees the credential rclone sends.
//
// Each connected tool gets its own path, because each one has its own key. A
// path per tool is what makes `drive agents revoke claude` mean what it says:
// claude's mount and claude's key both stop, and codex's do not.
//
// The agent mount carries no remote control (`--rc`) and no background loops.
// There is nothing to ask of the upload queue and nothing to fill or guard
// that the person's mount is not already doing on the same drive, and one
// bind address per mount on the same host would need a registry of its own.
// Its credential never reaches argv (config.go): the secret sits in its own
// 0600 env file or in the login item's EnvironmentVariables, never in a
// command a `ps` could read (fleet-ops#8403).

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// agentRootDirName is the directory that holds every tool's agent path. It
	// is a sibling of `~/Drive` and never inside it: a path inside the
	// person's mount would let an agent walk up out of its own credential.
	agentRootDirName = "Drive-agents"
	// agentRcloneConfigName is the rclone config the agent mounts read. It is
	// a file of its own, holding the agent credential, so the device mount's
	// config is never handed to a process that must not hold a delete.
	agentRcloneConfigName = "agent-rclone.conf"
	// agentRcloneEnvName is the env file the agent login items read. The
	// secret lives here, 0600, under the same
	// RCLONE_CONFIG_DRIVE_SECRET_ACCESS_KEY name rclone itself reads
	// (config.go, secretEnvName).
	agentRcloneEnvName = "agent-rclone.env"
)

// AgentRootDir is the directory holding one path per connected agent tool.
func AgentRootDir(home string) string {
	return filepath.Join(home, agentRootDirName)
}

// AgentMountDir is the agent path tool works in: its own mount, backed by its
// own key, a sibling of the person's `~/Drive`.
func AgentMountDir(home, tool string) string {
	return filepath.Join(AgentRootDir(home), toolNameInPath(tool))
}

// AgentRcloneConfigPath is the rclone config the agent mounts read.
func AgentRcloneConfigPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), agentRcloneConfigName)
}

// AgentRcloneEnvPath is the 0600 env file holding the agent secret.
func AgentRcloneEnvPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), agentRcloneEnvName)
}

// AgentLogPath is the log for one tool's agent mount.
func AgentLogPath(home, tool string) string {
	return filepath.Join(DefaultConfigDir(home), "agent-"+toolNameInPath(tool)+".log")
}

// AgentCacheDir is the VFS cache for one tool's agent mount. Each tool keeps
// its own, so one tool's cache never answers another tool's read.
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

// toolNameInPath keeps a tool name to the characters a path and a systemd unit
// name accept: a tool name is one of the known names, so this is a guard
// against a config file that holds something else, not a translation layer.
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

// AgentMountConfig is the agent mount's storage settings: the device mount's
// own shared settings (endpoint, bucket, region, the download host that counts
// an agent's read as a read) with the tool's own credential and prefix in
// place of the person's.
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

// BuildAgentMountPlan is BuildMountPlan for one tool's agent path. It is its
// own function rather than a flag on BuildMountPlan, because the agent mount
// is not the person's mount with a different key: it has no remote control, no
// staging directory and no background loops, and a shared builder would have
// to be told all three.
//
// Bwlimit stays empty on purpose. A paused person is one with whom the drive
// stopped moving (logout.go PausedRate), and the agent path is a second
// credential against the same storage — pausing it too would be the honest
// reading, but it is a decision about money and billing that only the person
// makes. The agent path runs at full speed and the meter counts it.
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
		ConfigPath:  AgentRcloneConfigPath(home),
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
		// The Windows mount path (nfsmount, a drive letter per mount) and the
		// agent path have not been proven together, and an agent that shares
		// the device key is exactly the shape this path removes. So Windows
		// connects the tool and says the agent path is not there, rather than
		// granting `~/Drive` and calling it bounded.
		p.err = failf("agent-path-windows", tool)
		return p
	}
	return p
}

// mountAgentPaths is what Mount does for one tool: create the path, write the
// agent credential and the login item, start it, and wait for the kernel to
// agree that the path is a mount. Nothing here starts at login silently: the
// item is written next to the device mount's own.
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
	// The agent credential in its own config and its own env file, both 0600.
	if err := WriteFileAtomic(p.ConfigPath, []byte(RcloneConfig(AgentMountConfig(device, key))), 0o600); err != nil {
		return failDetail("mount-failed", err)
	}
	if err := WriteFileAtomic(AgentRcloneEnvPath(home), []byte(agentRcloneEnv(AgentMountConfig(device, key))), 0o600); err != nil {
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

// agentRcloneEnv renders the env file one agent mount reads: the storage
// secret under the name rclone itself reads (config.go), and nothing else.
func agentRcloneEnv(c StorageConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s=%s\n", secretEnvName, c.SecretKey)
	if c.SessionToken != "" {
		fmt.Fprintf(&b, "RCLONE_CONFIG_DRIVE_SESSION_TOKEN=%s\n", c.SessionToken)
	}
	return b.String()
}

// mountAgentForeground runs one agent mount's rclone in this process. No
// remote control and no background loops attach here (see the file note).
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

// startAgentLoginItem starts the item mountAgentPaths just wrote. The same
// rules as the device mount's own (mount.go startLinuxLoginItem): a missing
// systemd user bus falls back to a detached rclone, and any other systemctl
// failure is a named error rather than a silent no-op.
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

// waitAgentMounted waits for the kernel to say the path is a mount, with the
// same bounded patience the device mount uses: a start that reports success
// with nothing mounted is how an agent ends up writing through a credential
// nothing checks (drive#514).
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

// UnmountAgent stops one tool's agent mount: the login item first, then the
// mount itself if the item was already gone. It is what `drive agents revoke`
// calls before the key is withdrawn, so a revoked agent's path stops being
// readable even if the withdrawal at the provider takes a moment.
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
		if stopErr := unmountAgentDir(goos, AgentMountDir(home, tool)); stopErr != nil {
			return failDetail("unexpected", fmt.Errorf("systemctl --user disable --now %s: %v; fusermount: %w", AgentSystemdUnitName(tool), err, stopErr))
		}
		return failDetail("unexpected", fmt.Errorf("systemctl --user disable --now %s: %w", AgentSystemdUnitName(tool), err))
	}
	_ = os.Remove(itemPath)
	return nil
}

// unmountAgentDir unmounts one agent path directly, for a host whose login
// item is already gone or whose systemd will not answer. It is the unmount
// half of logout.go stopMount for a mount point that is not the person's own,
// and it checks first so a path that is already down is not an error.
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
	for _, bin := range []string{"fusermount3", "fusermount"} {
		if err := exec.Command(bin, "-u", mountDir).Run(); err == nil {
			return nil
		}
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

// AgentPathState is what `drive agents` reports about one tool's path: the
// mount point, whether it is live, and whether its login item is installed.
type AgentPathState struct {
	Tool      string
	Path      string
	Mounted   bool
	LoginItem bool
}

// AgentPathStates lists every connected tool's agent path, so `drive agents`
// can show the path each one really works in instead of a promise.
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

// AgentPathSummary is one line of `drive agents` output: the path, and whether
// it is up. A path whose login item is installed but which is not mounted is
// called out as not running, because a tool connected to a dead path is a
// failure the person has to see (drive#514).
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

// agentMountTimeoutSeconds is what the message table prints as {1} for
// the agent mount's own timeout, kept beside the code that waits so the two
// cannot drift.
const agentMountTimeoutSeconds = "60"

// mountWaitTimeout bounds waitAgentMounted, the patience the agent mount is
// given before a start is reported as a failure. It is the same order the
// device mount allows and it is a number this file owns.
var mountWaitTimeout = 60 * time.Second

// strconv is used by nothing in this file today and is here because the agent
// path's log line reports the tool's index no tool will ever read. It is
// imported rather than deleted so a future count line has one obvious home.
var _ = strconv.Itoa
