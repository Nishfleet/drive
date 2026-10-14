package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func stubAgentPath(t *testing.T) {
	t.Helper()
	orig := startToolAgentPath
	startToolAgentPath = func(env Env, tool Tool) (string, error) {
		return AgentMountDir(env.Home, tool.Name), nil
	}
	t.Cleanup(func() { startToolAgentPath = orig })
}

func testAgentKey() agentKey {
	return agentKey{
		KeyID:        "key-agent-1",
		AccessKeyID:  "AKIACLAUDE",
		Secret:       "s3cr3t-value",
		Capabilities: []string{"list", "read", "write"},
		Endpoint:     "https://s3.example.invalid",
		Bucket:       "drive-standin",
		Prefix:       "u/acct/",
		Region:       "us-east-1",
	}
}

func testDeviceConfig() StorageConfig {
	return StorageConfig{
		Endpoint:  "https://s3.example.invalid",
		AccessKey: "DEVICEAK",
		SecretKey: "devicesecret",
		Bucket:    "drive-standin",
		Prefix:    "u/acct/",
		Region:    "us-east-1",
	}
}

func TestAgentMountPlanCarriesTheAgentKey(t *testing.T) {
	home := t.TempDir()
	key := testAgentKey()
	p := BuildAgentMountPlan("linux", home, "/usr/bin/rclone", "claude", AgentMountConfig(testDeviceConfig(), key))
	if p.err != nil {
		t.Fatalf("plan: %v", p.err)
	}
	if p.RcloneBin != "/usr/bin/rclone" {
		t.Errorf("rclone bin = %q", p.RcloneBin)
	}
	if p.MountDir != AgentMountDir(home, "claude") {
		t.Errorf("mount dir = %q, want %q", p.MountDir, AgentMountDir(home, "claude"))
	}
	if p.ConfigPath != AgentRcloneConfigPath(home, "claude") {
		t.Errorf("config path = %q", p.ConfigPath)
	}
	if p.EnvPath != AgentRcloneEnvPath(home, "claude") {
		t.Errorf("env path = %q, want the agent env file", p.EnvPath)
	}
	if p.Remote != "drive:drive-standin/u/acct" && p.Remote != "drive:drive-standin/u/acct/" {
		if !strings.Contains(p.Remote, "drive-standin") || !strings.Contains(p.Remote, "u/acct") {
			t.Errorf("remote = %q, want the agent prefix", p.Remote)
		}
	}
	args := strings.Join(p.Args(), " ")
	if strings.Contains(args, key.Secret) || strings.Contains(args, key.AccessKeyID) {
		t.Errorf("the agent key is in argv: %s", args)
	}
	if strings.Contains(args, "--rc") || strings.Contains(args, ":5572") {
		t.Errorf("the agent path has a remote control it does not need: %s", args)
	}
	if strings.Contains(args, "/rclone.conf") {
		t.Errorf("argv names the device mount's config: %s", args)
	}
	if !strings.Contains(args, "agent-claude-rclone.conf") {
		t.Errorf("argv does not name the agent config: %s", args)
	}
	unit := SystemdUnit(p)
	if !strings.Contains(unit, "agent-claude-rclone.env") {
		t.Errorf("systemd unit does not load the agent env file:\n%s", unit)
	}
	if strings.Contains(unit, filepath.Join(filepath.Dir(p.ConfigPath), "rclone.env")+"\n") ||
		strings.Contains(unit, "EnvironmentFile="+filepath.Join(filepath.Dir(p.ConfigPath), "rclone.env")) {
		if !strings.Contains(unit, "agent-claude-rclone.env") {
			t.Errorf("systemd unit loads the device rclone.env:\n%s", unit)
		}
	}
}

func TestAgentRcloneEnvCarriesRcloneOwnSecretName(t *testing.T) {
	got := agentRcloneEnv(StorageConfig{SecretKey: "s3cr3t-value"})
	if !strings.Contains(got, rcloneSecretEnv+"=") {
		t.Fatalf("agent env file does not use rclone's own secret name:\n%s", got)
	}
	if strings.Contains(got, secretEnvName+"=") {
		t.Fatalf("agent env file still uses the CLI's own name rclone does not read:\n%s", got)
	}
}

func TestAgentMountedDirSeesTheAgentMountPoint(t *testing.T) {
	if got, want := AgentMountDir("/home/u", "claude"), filepath.Join("/home/u", "Drive-agents", "claude"); got != want {
		t.Errorf("agent mount dir = %q, want %q", got, want)
	}
	env, _ := testEnv(t)
	if got := AgentMountDir(env.Home, "codex"); got == env.DriveDir {
		t.Errorf("agent path = the drive folder %q", got)
	}
}

func TestAgentStateReportsMissingKey(t *testing.T) {
	env, _ := testEnv(t)
	bad := BuildAgentMountPlan("linux", env.Home, "/usr/bin/rclone", "claude", StorageConfig{})
	if bad.err == nil {
		t.Fatal("a plan with no storage settings must be a named failure")
	}
	if bad.ConfigPath != AgentRcloneConfigPath(env.Home, "claude") {
		t.Fatalf("a failed plan carries no config path: %+v", bad)
	}
}

func TestWindowsAgentPathLeavesTheToolInTheDrive(t *testing.T) {
	env, _ := testEnv(t)
	dir, err := agentPathForGOOS("windows", env, Tool{Name: "claude"})
	if err != nil {
		t.Fatalf("windows must still connect: %v", err)
	}
	if dir != "" {
		t.Fatalf("windows agent dir = %q, want empty so Connect keeps DriveDir", dir)
	}
}

func TestAgentToolsDoNotShareCredentialFiles(t *testing.T) {
	home := t.TempDir()
	a := BuildAgentMountPlan("linux", home, "/usr/bin/rclone", "claude", AgentMountConfig(testDeviceConfig(), testAgentKey()))
	b := BuildAgentMountPlan("linux", home, "/usr/bin/rclone", "codex", AgentMountConfig(testDeviceConfig(), testAgentKey()))
	if a.ConfigPath == b.ConfigPath {
		t.Errorf("two tools share one config file: %q", a.ConfigPath)
	}
	if a.EnvPath == b.EnvPath {
		t.Errorf("two tools share one env file: %q", a.EnvPath)
	}
	if a.MountDir == b.MountDir {
		t.Errorf("two tools share one mount dir: %q", a.MountDir)
	}
}

func TestUnmountAgentWithoutSystemdStillLetsRevokeGo(t *testing.T) {
	home := t.TempDir()
	item := AgentLoginItemPath("linux", home, "claude")
	if err := os.MkdirAll(filepath.Dir(item), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(item, []byte("[Unit]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	if err := UnmountAgent("linux", home, "claude"); err != nil {
		t.Fatalf("an absent systemd must not block revoke: %v", err)
	}
	if _, err := os.Stat(item); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the login item must be gone after the stop: %v", err)
	}
}

func TestOneToolsAgentPathDoesNotReachTheNextTool(t *testing.T) {
	orig := startToolAgentPath
	startToolAgentPath = func(env Env, tool Tool) (string, error) {
		if tool.Name == "claude" {
			return AgentMountDir(env.Home, "claude"), nil
		}
		return "", nil
	}
	t.Cleanup(func() { startToolAgentPath = orig })
	env, runner := testEnv(t)
	if err := initAgents(env); err != nil {
		t.Fatal(err)
	}
	agentRoot := AgentRootDir(env.Home)
	sawClaude := false
	for _, call := range runner.calls {
		isClaude := strings.HasPrefix(call, "claude ")
		if isClaude {
			sawClaude = true
		}
		if strings.Contains(call, agentRoot) && !isClaude {
			t.Errorf("a tool with no agent path was pointed at one: %q", call)
		}
	}
	if !sawClaude {
		t.Fatalf("claude never connected: %q", runner.calls)
	}
}
