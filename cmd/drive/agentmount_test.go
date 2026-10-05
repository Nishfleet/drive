package main

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestAgentMountPlanCarriesTheAgentKey holds the agent path's plan to the
// tool's own key and to nothing else (drive#514): the plan's remote carries the
// agent key id, the device mount's credential files are never in argv, and
// there is no remote control because the agent path runs no background loops.
func TestAgentMountPlanCarriesTheAgentKey(t *testing.T) {
	_, _ = testEnv(t)
	home := t.TempDir()
	key := MintedKey{
		KeyID:        "key-agent-1",
		AccessKeyID:  "AKIACLAUDE",
		Secret:       "s3cr3t-value",
		Capabilities: []string{"list", "read", "write"},
		Endpoint:     "https://s3.example.invalid",
		Bucket:       "drive-standin",
	}
	device, err := LoadStorageConfig(key.Endpoint, key.Bucket, "", "", "", key.Secret, StorageConfig{AccessKey: key.AccessKeyID})
	if err != nil {
		t.Fatal(err)
	}
	p := BuildAgentMountPlan("linux", home, "/usr/bin/rclone", "claude", device)
	if p.RcloneBin != "/usr/bin/rclone" {
		t.Errorf("rclone bin = %q", p.RcloneBin)
	}
	if p.MountDir != AgentMountDir(home, "claude") {
		t.Errorf("mount dir = %q, want %q", p.MountDir, AgentMountDir(home, "claude"))
	}
	args := strings.Join(p.Args(), " ")
	if strings.Contains(args, key.Secret) || strings.Contains(args, key.AccessKeyID) {
		t.Errorf("the agent key is in argv: %s", args)
	}
	if strings.Contains(args, "--rc") || strings.Contains(args, "5572") {
		t.Errorf("the agent path has a remote control it does not need: %s", args)
	}
	if strings.Contains(args, "/rclone.conf") {
		t.Errorf("argv names the device mount's config: %s", args)
	}
}

// TestAgentMountedDirSeesTheAgentMountPoint keeps the agent path out of the
// person's drive folder: a tool inside the person's mount could delete past
// the server's own allowlist, which is the bug this issue fixes.
func TestAgentMountedDirSeesTheAgentMountPoint(t *testing.T) {
	if got, want := AgentMountDir("/home/u", "claude"), filepath.Join("/home/u", "Drive-agents", "claude"); got != want {
		t.Errorf("agent mount dir = %q, want %q", got, want)
	}
	env, _ := testEnv(t)
	if got := AgentMountDir(env.Home, "codex"); got == env.DriveDir {
		t.Errorf("agent path = the drive folder %q", got)
	}
}

// TestAgentStateReportsMissingKey says what a person sees before the key is
// on disk, so a per-tool failure is a named failure and not a bare error.
func TestAgentStateReportsMissingKey(t *testing.T) {
	env, _ := testEnv(t)
	bad := BuildAgentMountPlan("linux", env.Home, "/usr/bin/rclone", "claude", StorageConfig{})
	if bad.err == nil {
		t.Fatal("a plan with no storage settings must be a named failure")
	}
	if bad.ConfigPath != AgentRcloneConfigPath(env.Home) {
		t.Fatalf("a failed plan carries no config path: %+v", bad)
	}
}
