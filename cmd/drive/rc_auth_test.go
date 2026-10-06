package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareMountAuthWritesEnvAt0600AndOmitsTheSecretFromConf(t *testing.T) {
	home := t.TempDir()
	cfg := testStorage()
	p := BuildMountPlan("linux", home, "rclone", cfg)
	if err := prepareMountAuth(home, &p, cfg); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(RcloneEnvPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("rclone.env mode %04o, want 0600", perm)
	}
	env, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatal(err)
	}
	body := string(env)
	if !strings.Contains(body, cfg.SecretKey) {
		t.Errorf("rclone.env missing the storage secret")
	}
	if p.RCUser == "" || p.RCPass == "" {
		t.Fatal("prepareMountAuth left RCUser/RCPass empty")
	}
	if !strings.Contains(body, p.RCUser) || !strings.Contains(body, p.RCPass) {
		t.Errorf("rclone.env missing the rc user/pass")
	}
	conf := RcloneConfig(cfg)
	if strings.Contains(conf, cfg.SecretKey) || strings.Contains(conf, "secret_access_key") {
		t.Errorf("rclone.conf still carries the storage secret:\n%s", conf)
	}
	auth, err := ReadRCAuth(home)
	if err != nil {
		t.Fatal(err)
	}
	if auth.User != p.RCUser || auth.Pass != p.RCPass {
		t.Errorf("ReadRCAuth = %+v, want the generated pair", auth)
	}
}

func TestSystemdUnitKeepsSecretsOutOfThe0644File(t *testing.T) {
	p := withProductBin(BuildMountPlan("linux", "/home/test", "/usr/bin/rclone", testStorage()))
	p.RCUser, p.RCPass, p.SecretKey = "rcuserhex", "rcpasshex", testStorage().SecretKey
	unit := SystemdUnit(p)
	for _, secret := range []string{"rcuserhex", "rcpasshex", testStorage().SecretKey} {
		if strings.Contains(unit, secret) {
			t.Errorf("systemd unit (0644) carries %q:\n%s", secret, unit)
		}
	}
	if strings.Contains(unit, "Environment=") || strings.Contains(unit, "EnvironmentFile=") {
		t.Errorf("a 0644 unit must not carry secrets or an EnvironmentFile=:\n%s", unit)
	}
	if strings.Contains(unit, "--rc-user") || strings.Contains(unit, "--rc-pass") {
		t.Errorf("ExecStart still has --rc-user/--rc-pass:\n%s", unit)
	}
	if strings.Contains(unit, "--rc-no-auth") {
		t.Errorf("unit still disables rc auth:\n%s", unit)
	}
}

func TestLaunchdPlistKeepsSecretsOutOfTheItem(t *testing.T) {
	p := withProductBin(BuildMountPlan("darwin", "/Users/test", "/opt/homebrew/bin/rclone", testStorage()))
	p.RCUser, p.RCPass, p.SecretKey = "rcuserhex", "rcpasshex", testStorage().SecretKey
	plist := LaunchdPlist(p)
	for _, secret := range []string{"rcuserhex", "rcpasshex", testStorage().SecretKey, rcloneRCUserEnv, rcloneRCPassEnv, rcloneSecretEnv} {
		if strings.Contains(plist, secret) {
			t.Errorf("launchd plist carries %q:\n%s", secret, plist)
		}
	}
	if strings.Contains(plist, "--rc-no-auth") {
		t.Errorf("plist still disables rc auth:\n%s", plist)
	}
}

func TestForegroundArgsPassRCUserAndPass(t *testing.T) {
	p := BuildMountPlan("linux", "/home/test", "/usr/bin/rclone", testStorage())
	p.RCUser, p.RCPass = "rcuserhex", "rcpasshex"
	args := p.Args()
	if !hasArgPair(args, "--rc-user", "rcuserhex") || !hasArgPair(args, "--rc-pass", "rcpasshex") {
		t.Errorf("Args() missing --rc-user/--rc-pass: %v", args)
	}
	if hasArg(args, "--rc-no-auth") {
		t.Errorf("Args() still has --rc-no-auth: %v", args)
	}
	login := p.loginItemArgs()
	if hasArg(login, "--rc-user") || hasArg(login, "--rc-pass") {
		t.Errorf("loginItemArgs still has rc flags: %v", login)
	}
}

// TestUnauthenticatedConfigDumpIsRejectedOnALiveMount is finish line 3:
// an unauthenticated config/dump against a live mount the product started
// gets 401/403, so a local process cannot read secret_access_key.
func TestUnauthenticatedConfigDumpIsRejectedOnALiveMount(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg, _ := standinOn(t, root, "u/rcauth")
	home := filepath.Join(root, "home")
	mountDir := filepath.Join(home, "Drive")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = standinEnv(t, home, cfg)
	t.Setenv("DRIVE_RC_ADDR", "127.0.0.1:"+freePort(t))
	_, stop := startStandinMount(t, home, mountDir, cfg)
	defer stop()

	conf, err := os.ReadFile(RcloneConfigPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(conf), cfg.SecretKey) || strings.Contains(string(conf), "secret_access_key") {
		t.Errorf("live rclone.conf still carries the storage secret:\n%s", conf)
	}

	addr := RCAddr()
	resp, err := http.Post("http://"+addr+"/config/dump", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("unauthenticated config/dump: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unauthenticated config/dump status %d, want 401 or 403", resp.StatusCode)
	}
	t.Logf("unauthenticated config/dump on live mount at %s: HTTP %d", addr, resp.StatusCode)
}
