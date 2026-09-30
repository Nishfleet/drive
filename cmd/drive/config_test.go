package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testStorage() StorageConfig {
	return StorageConfig{
		Endpoint:  "http://127.0.0.1:39181",
		AccessKey: "DRIVETESTACCESSKEY",
		SecretKey: "drivetestsecret",
		Bucket:    "drive-standin",
		Prefix:    "u/1234",
		Region:    "us-east-1",
	}
}

func TestRcloneConfigRendersS3Remote(t *testing.T) {
	got := RcloneConfig(testStorage())
	for _, want := range []string{
		"[drive]",
		"type = s3",
		"provider = Other",
		"endpoint = http://127.0.0.1:39181",
		"region = us-east-1",
		"access_key_id = DRIVETESTACCESSKEY",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rclone config missing %q:\n%s", want, got)
		}
	}
}

func TestRemoteForTrimsPrefix(t *testing.T) {
	cases := map[string]string{
		"u/1234":         "drive:drive-standin/u/1234",
		"/u/1234/":       "drive:drive-standin/u/1234",
		"":               "drive:drive-standin",
		"u/1/branches/a": "drive:drive-standin/u/1/branches/a",
	}
	for prefix, want := range cases {
		c := testStorage()
		c.Prefix = prefix
		if got := RemoteFor(c); got != want {
			t.Errorf("RemoteFor(%q) = %q, want %q", prefix, got, want)
		}
	}
}

func TestLoadStorageConfigRequiresEveryValue(t *testing.T) {
	if _, err := LoadStorageConfig("", "", "", "", "", ""); err == nil {
		t.Fatal("expected an error when no storage config is given")
	} else if !strings.Contains(err.Error(), "missing storage config") {
		t.Fatalf("unexpected error text: %v", err)
	}
	c, err := LoadStorageConfig("http://x", "b", "", "", "a", "s")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Region != "us-east-1" {
		t.Errorf("default region = %q, want us-east-1", c.Region)
	}
}

func TestLoadStorageConfigPrefersFlagsOverEnv(t *testing.T) {
	t.Setenv("DRIVE_S3_ENDPOINT", "http://from-env")
	c, err := LoadStorageConfig("http://from-flag", "b", "p", "", "a", "s")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Endpoint != "http://from-flag" {
		t.Errorf("endpoint = %q, want the flag value", c.Endpoint)
	}
}

// The mount must carry the three VFS flags docs/build-spec.md names, on both
// platforms, and use the platform's own rclone subcommand. --dir-cache-time is
// one of them: S3 sends no change notifications, so without it a save from the
// other machine waits out rclone's 5-minute default (issue #62).
func TestMountPlanUsesVFSFlagsAndPlatformSubcommand(t *testing.T) {
	for _, tc := range []struct{ goos, sub string }{{"darwin", "nfsmount"}, {"linux", "mount"}} {
		p := BuildMountPlan(tc.goos, "/home/test", "/usr/bin/rclone", testStorage())
		if p.Subcommand != tc.sub {
			t.Errorf("%s: subcommand = %q, want %q", tc.goos, p.Subcommand, tc.sub)
		}
		line := p.CommandLine()
		for _, want := range []string{
			"--vfs-cache-mode full",
			"--vfs-write-back 5s",
			"--vfs-cache-max-size 20G",
			"--dir-cache-time 5s",
		} {
			if !strings.Contains(line, want) {
				t.Errorf("%s: command line missing %q:\n%s", tc.goos, want, line)
			}
		}
		if !strings.Contains(line, "drive:drive-standin/u/1234") {
			t.Errorf("%s: command line missing the device remote:\n%s", tc.goos, line)
		}
	}
}

func TestLaunchdPlistCarriesTheRclonePlan(t *testing.T) {
	p := BuildMountPlan("darwin", "/Users/test", "/opt/homebrew/bin/rclone", testStorage())
	plist := LaunchdPlist(p)
	for _, want := range []string{
		"<string>" + LaunchdLabel + "</string>",
		"<string>/opt/homebrew/bin/rclone</string>",
		"<string>nfsmount</string>",
		"<string>drive:drive-standin/u/1234</string>",
		"<string>--vfs-cache-mode</string>",
		"<string>--dir-cache-time</string>",
		"<true/>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("launchd plist missing %q:\n%s", want, plist)
		}
	}
	if p := LaunchdPlistPath("/Users/test"); p != "/Users/test/Library/LaunchAgents/com.nishfleet.drive.plist" {
		t.Errorf("LaunchdPlistPath = %q", p)
	}
}

func TestSystemdUnitCarriesTheRclonePlan(t *testing.T) {
	p := BuildMountPlan("linux", "/home/test", "/usr/bin/rclone", testStorage())
	unit := SystemdUnit(p)
	for _, want := range []string{
		"ExecStart=/usr/bin/rclone mount drive:drive-standin/u/1234",
		"--vfs-cache-mode full",
		"--dir-cache-time 5s",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("systemd unit missing %q:\n%s", want, unit)
		}
	}
	if p := SystemdUnitPath("/home/test"); p != "/home/test/.config/systemd/user/drive-mount.service" {
		t.Errorf("SystemdUnitPath = %q", p)
	}
}

func TestWriteFileAtomicLeavesNoPartialFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "rclone.conf")
	if err := WriteFileAtomic(path, []byte("[drive]\n"), 0o600); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "[drive]\n" {
		t.Errorf("content = %q", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("mode = %o, want 600 (the file holds the device's secret key)", perm)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	if len(entries) != 1 {
		t.Errorf("temp files left behind: %v", entries)
	}
}

func TestRcloneConfigRedactedHidesBothKeys(t *testing.T) {
	c := testStorage()
	got := RcloneConfigRedacted(c)
	if strings.Contains(got, c.AccessKey) || strings.Contains(got, c.SecretKey) {
		t.Errorf("redacted config still carries a key:\n%s", got)
	}
	for _, want := range []string{"access_key_id = <redacted>", "secret_access_key = <redacted>", c.Endpoint} {
		if !strings.Contains(got, want) {
			t.Errorf("redacted config missing %q:\n%s", want, got)
		}
	}
}

func TestLoadStorageConfigRejectsValuesThatWouldInjectAnOption(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*StorageConfig)
	}{
		{"newline in secret", func(c *StorageConfig) { c.SecretKey = "SECRET\nno_check_certificate = true" }},
		{"cr in endpoint", func(c *StorageConfig) { c.Endpoint = "http://x\r\nprovider = Other" }},
		{"nul in bucket", func(c *StorageConfig) { c.Bucket = "bucket\x00x" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testStorage()
			tc.mutate(&c)
			// LoadStorageConfig is the gate: feed the mutated value through as
			// the flag, which wins over env.
			_, err := LoadStorageConfig(c.Endpoint, c.Bucket, c.Prefix, c.Region, c.AccessKey, c.SecretKey)
			if err == nil {
				t.Fatal("want an error for a value that breaks out of its config line")
			}
		})
	}
}

func TestSystemdUnitQuotesForSystemd(t *testing.T) {
	// systemd does not use shell quoting: a plain path stays bare, and every
	// percent must be doubled or systemd expands it as a specifier.
	if got := systemdEscapeArg("/usr/bin/rclone"); got != "/usr/bin/rclone" {
		t.Errorf("bare path = %q", got)
	}
	if got := systemdEscapeArg("/home/a b/rclone"); got != `"/home/a b/rclone"` {
		t.Errorf("spaced path = %q", got)
	}
	if got := systemdEscapeArg("/home/%h/rclone"); got != "/home/%%h/rclone" {
		t.Errorf("percent path = %q", got)
	}
	if got := systemdEscapeArg(`/a\b"c`); got != `"/a\\b\"c"` {
		t.Errorf("escaped path = %q", got)
	}
}

func TestBsdMountHasMountPoint(t *testing.T) {
	listing := "/dev/disk3s1 on / (apfs, local)\n" +
		"drive: on /Users/test/Drive (nfs, nodev)\n" +
		"/dev/disk5 on /Volumes/My\\040Disk (apfs, local)\n"
	for _, dir := range []string{"/Users/test/Drive", "/Volumes/My Disk"} {
		if !bsdMountHasMountPoint(listing, dir) {
			t.Errorf("mount point %q not found", dir)
		}
	}
	for _, dir := range []string{"/Users/test", "/Volumes/My", "/Users/test/DriveX"} {
		if bsdMountHasMountPoint(listing, dir) {
			t.Errorf("mount point %q reported mounted but is not a mount point", dir)
		}
	}
}
