package main

import (
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	if _, err := LoadStorageConfig("", "", "", "", ""); err == nil {
		t.Fatal("expected an error when no storage config is given")
	} else if !strings.Contains(err.Error(), "missing storage config") {
		t.Fatalf("unexpected error text: %v", err)
	}
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "a")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "s")
	c, err := LoadStorageConfig("http://x", "b", "", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Region != "us-east-1" {
		t.Errorf("default region = %q, want us-east-1", c.Region)
	}
}

// The keys are read from the environment only: a flag would put a device key
// in `ps` output and the shell history.
func TestLoadStorageConfigReadsTheKeysFromTheEnvironment(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "envaccess")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "envsecret")
	c, err := LoadStorageConfig("http://x", "b", "p", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.AccessKey != "envaccess" || c.SecretKey != "envsecret" {
		t.Errorf("keys = %q/%q, want the environment values", c.AccessKey, c.SecretKey)
	}
}

// There is no flag to put a key in, so a key cannot be smuggled in as one.
func TestMountRefusesAKeyFlag(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "envaccess")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "envsecret")
	out, err := exec.Command(driveBin(t), "mount",
		"--endpoint", "http://x", "--bucket", "b",
		"--access-key", "leaked", "--secret-key", "leaked", "--dry-run").CombinedOutput()
	if err == nil {
		t.Fatalf("expected a usage error for the removed key flags, got:\n%s", out)
	}
	if !strings.Contains(string(out), "flag provided but not defined: -access-key") {
		t.Errorf("expected a flag-not-defined usage error, got:\n%s", out)
	}
}

func TestLoadStorageConfigPrefersFlagsOverEnv(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "a")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "s")
	t.Setenv("DRIVE_S3_ENDPOINT", "http://from-env")
	c, err := LoadStorageConfig("http://from-flag", "b", "p", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Endpoint != "http://from-flag" {
		t.Errorf("endpoint = %q, want the flag value", c.Endpoint)
	}
}

// The mount must carry every VFS flag the product mounts with, on both
// platforms, and use the platform's own rclone subcommand. --dir-cache-time is
// the fourth: S3 sends no change notifications, so without it a save from the
// other machine waits out rclone's 5-minute default (issue #62; the step-3
// proof in PR #61 carries the same flag into docs/build-spec.md).
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
		// The flag and its value are one pair: a plan that emitted
		// --dir-cache-time with no value would still match the substring
		// above, and rclone would take the next argument as the duration.
		if args := p.Args(); !hasArgPair(args, "--dir-cache-time", "5s") {
			t.Errorf("%s: --dir-cache-time and 5s are not adjacent args:\n%v", tc.goos, args)
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
		"<true/>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("launchd plist missing %q:\n%s", want, plist)
		}
	}
	// ProgramArguments is an argv array: the flag and its value are two
	// adjacent elements, and rclone would read the next element as the
	// duration if the value were dropped.
	args := plistProgramArguments(t, plist)
	if !hasArgPair(args, "--dir-cache-time", "5s") {
		t.Errorf("launchd ProgramArguments missing adjacent --dir-cache-time 5s:\n%v", args)
	}
	if p := LaunchdPlistPath("/Users/test"); p != "/Users/test/Library/LaunchAgents/com.nishfleet.drive.plist" {
		t.Errorf("LaunchdPlistPath = %q", p)
	}
}

// plistProgramArguments returns the <string> elements of the plist's
// ProgramArguments array, in order, as argv elements.
func plistProgramArguments(t *testing.T, plist string) []string {
	t.Helper()
	start := strings.Index(plist, "<key>ProgramArguments</key>")
	if start < 0 {
		t.Fatal("plist has no ProgramArguments:" + plist)
	}
	open := strings.Index(plist[start:], "<array>")
	closee := strings.Index(plist[start:], "</array>")
	if open < 0 || closee < 0 {
		t.Fatal("plist ProgramArguments is not an array:" + plist)
	}
	body := plist[start+open : start+closee]
	var args []string
	for _, m := range regexp.MustCompile(`<string>(.*?)</string>`).FindAllStringSubmatch(body, -1) {
		args = append(args, html.UnescapeString(m[1]))
	}
	return args
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
	// rclone has no `umount` subcommand; stopping is rclone's own SIGTERM
	// handling, which is what systemd sends by default.
	if strings.Contains(unit, "ExecStop") {
		t.Errorf("systemd unit has an ExecStop line rclone cannot run:\n%s", unit)
	}
	// The flag and value must be adjacent on the ExecStart line (not in a comment).
	execStart := extractExecStart(unit)
	if !hasArgPair(strings.Fields(execStart), "--dir-cache-time", "5s") {
		t.Errorf("ExecStart line missing adjacent --dir-cache-time 5s:\n%s", execStart)
	}
	if p := SystemdUnitPath("/home/test"); p != "/home/test/.config/systemd/user/drive-mount.service" {
		t.Errorf("SystemdUnitPath = %q", p)
	}
}

func extractExecStart(unit string) string {
	for _, line := range strings.Split(unit, "\n") {
		if strings.HasPrefix(line, "ExecStart=") {
			return line
		}
	}
	return ""
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

// hasArgPair reports whether args carries flag immediately followed by value,
// which is the shape rclone's flag parser requires: a flag whose value is a
// separate argv element, not one string.
func hasArgPair(args []string, flag, value string) bool {
	for i, a := range args {
		if a == flag {
			return i+1 < len(args) && args[i+1] == value
		}
	}
	return false
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
		{"parent segment in prefix", func(c *StorageConfig) { c.Prefix = "u/1/../2" }},
		{"prefix above the bucket root", func(c *StorageConfig) { c.Prefix = "../other-device" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := testStorage()
			tc.mutate(&c)
			// LoadStorageConfig is the gate: feed the mutated value through as
			// the flag, which wins over env.
			t.Setenv("DRIVE_S3_ACCESS_KEY_ID", c.AccessKey)
			t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", c.SecretKey)
			if _, err := LoadStorageConfig(c.Endpoint, c.Bucket, c.Prefix, c.Region, c.DownloadURL); err == nil {
				t.Fatal("want an error for a value that breaks out of its config line")
			}
		})
	}
}

// A prefix that only walks down is fine, and an empty one is the whole bucket.
func TestLoadStorageConfigAcceptsAPrefixInsideTheDevice(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "a")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "s")
	for _, prefix := range []string{"", "/", "u/1", "/u/1/branches/", "u/1/...hidden"} {
		if _, err := LoadStorageConfig("http://x", "b", prefix, "", ""); err != nil {
			t.Errorf("prefix %q rejected: %v", prefix, err)
		}
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

// `drive mount --dry-run` renders the config it would write; it must never
// print either device key, so a dry run on a shared screen or in a terminal
// transcript cannot leak the key even though it was in the environment.
func TestMountDryRunNeverPrintsAKey(t *testing.T) {
	const access, secret = "DRYRUNACCESSKEY", "dryrun-secret-value"
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", access)
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", secret)
	out, err := exec.Command(driveBin(t), "mount",
		"--endpoint", "http://127.0.0.1:1", "--bucket", "drive-dry-run",
		"--prefix", "u/dryrun", "--home", t.TempDir(), "--dry-run").CombinedOutput()
	if err != nil {
		t.Fatalf("dry run failed: %v\n%s", err, out)
	}
	if strings.Contains(string(out), secret) {
		t.Errorf("dry-run output carries the secret key:\n%s", out)
	}
	if strings.Contains(string(out), access) {
		t.Errorf("dry-run output carries the access key:\n%s", out)
	}
}

// A login item has no shell PATH, so the plan must carry an absolute rclone
// path (Homebrew's is /opt/homebrew/bin/rclone) rather than a bare name.
func TestResolveRcloneReturnsAnAbsolutePath(t *testing.T) {
	got, err := ResolveRclone("")
	if err != nil {
		t.Skipf("rclone is not installed on this host: %v", err)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("ResolveRclone(\"\") = %q, want an absolute path", got)
	}
	if got, err := ResolveRclone("rclone"); err != nil || !filepath.IsAbs(got) {
		t.Errorf("ResolveRclone(\"rclone\") = %q, %v; want an absolute path", got, err)
	}
	if _, err := ResolveRclone("rclone-that-is-not-installed"); err == nil {
		t.Error("a named rclone that is not installed should fail here, not at the next login")
	}
	t.Setenv("DRIVE_RCLONE", "rclone")
	if got, err := ResolveRclone(""); err != nil || !filepath.IsAbs(got) {
		t.Errorf("DRIVE_RCLONE was ignored: %q, %v", got, err)
	}
}

// The launchctl verbs are bootstrap/bootout, not the deprecated load/unload
// that also fail when the item is already in the requested state.
func TestLaunchctlUsesBootstrapNotDeprecatedLoad(t *testing.T) {
	const target = "gui/501"
	cases := []struct {
		action string
		item   string
		want   string
	}{
		{"print", "", "print gui/501/" + LaunchdLabel},
		{"bootout", "", "bootout gui/501/" + LaunchdLabel},
		{"bootstrap", "/Users/test/Library/LaunchAgents/" + LaunchdLabel + ".plist",
			"bootstrap gui/501 /Users/test/Library/LaunchAgents/" + LaunchdLabel + ".plist"},
	}
	for _, tc := range cases {
		if got := strings.Join(launchctlArgv(tc.action, target, tc.item), " "); got != tc.want {
			t.Errorf("launchctlArgv(%q) = %q, want %q", tc.action, got, tc.want)
		}
	}
	for _, gone := range []string{"load", "unload"} {
		if launchctlArgv(gone, target, "/p.plist") != nil {
			t.Errorf("deprecated launchctl action %q is still built", gone)
		}
	}
}

// A relative path from LookPath is not usable in a login item, which is not
// started from a working directory.
func TestAbsPathMakesARelativeLookPathAbsolute(t *testing.T) {
	got, err := absPath("./rclone")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("absPath(./rclone) = %q, want an absolute path", got)
	}
	if got, err := absPath("/usr/bin/rclone"); err != nil || got != "/usr/bin/rclone" {
		t.Errorf("absPath(/usr/bin/rclone) = %q, %v", got, err)
	}
}

// The Linux start path must apply the unit it just wrote, not leave a running
// unit with the old configuration: enable --now does not restart an active
// unit, so the caller has to restart.
func TestMountLinuxRestartsAnAlreadyRunningUnit(t *testing.T) {
	got := mountSystemctlActions()
	want := []string{"daemon-reload", "enable", "restart"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("systemctl actions = %v, want %v", got, want)
	}
}
