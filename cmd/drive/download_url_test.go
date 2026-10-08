package main

import (
	"os"
	"strings"
	"testing"
)

// The dl Worker URL carries the key's download grant (drive#517), so it is a
// read capability. The mount hands it to rclone through the 0600 environment
// and never on the command line, where any local process can read it.
const testDownloadURL = "https://dl.example.test/k/grantpayload.grantsig/"

func TestMountPassesTheDownloadURLThroughTheEnvironmentOnly(t *testing.T) {
	home := t.TempDir()
	cfg := testStorage()
	cfg.DownloadURL = testDownloadURL
	p := BuildMountPlan("linux", home, "rclone", cfg)
	if err := prepareMountAuth(home, &p, cfg); err != nil {
		t.Fatal(err)
	}
	env, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(env), rcloneDownloadURLEnv+"=") || !strings.Contains(string(env), testDownloadURL) {
		t.Errorf("rclone.env does not carry the download URL:\n%s", env)
	}
	found := false
	for _, kv := range rcloneProcessEnv(p) {
		if kv == rcloneDownloadURLEnv+"="+testDownloadURL {
			found = true
		}
	}
	if !found {
		t.Errorf("the foreground mount's environment has no %s", rcloneDownloadURLEnv)
	}
	for _, args := range [][]string{p.Args(), p.loginItemArgs(), p.productArgs()} {
		for _, a := range args {
			if strings.Contains(a, "grantpayload") || a == "--s3-download-url" {
				t.Fatalf("the download grant is on rclone's command line: %v", args)
			}
		}
	}
	unit := SystemdUnit(p)
	if strings.Contains(unit, "grantpayload") {
		t.Errorf("the 0644 systemd unit carries the download grant:\n%s", unit)
	}
	// The launchd item runs the product (drive#515), so the plist carries no
	// grant either: the product reads rclone.env and hands it to its rclone child
	// as an environment variable.
	darwin := BuildMountPlan("darwin", "/Users/test", "/opt/homebrew/bin/rclone", cfg)
	plist := LaunchdPlist(darwin)
	if strings.Contains(plist, "grantpayload") || strings.Contains(plist, testDownloadURL) {
		t.Errorf("the launchd plist carries the download grant:\n%s", plist)
	}
}

func TestMountWithoutADownloadURLSetsNone(t *testing.T) {
	home := t.TempDir()
	cfg := testStorage()
	cfg.DownloadURL = ""
	p := BuildMountPlan("linux", home, "rclone", cfg)
	if err := prepareMountAuth(home, &p, cfg); err != nil {
		t.Fatal(err)
	}
	env, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(env), rcloneDownloadURLEnv) {
		t.Errorf("rclone.env names a download URL that was never set:\n%s", env)
	}
}
