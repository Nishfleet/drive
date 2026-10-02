package main

import (
	"html"
	"io"
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
	if _, err := LoadStorageConfig("", "", "", "", "", ""); err == nil {
		t.Fatal("expected an error when no storage config is given")
	} else if !strings.Contains(err.Error(), "missing storage config") {
		t.Fatalf("unexpected error text: %v", err)
	}
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "a")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "s")
	secret, err := ReadSecretKey("", false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	c, err := LoadStorageConfig("http://x", "b", "", "", "", secret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Region != "us-east-1" {
		t.Errorf("default region = %q, want us-east-1", c.Region)
	}
}

// The access key is read from the environment only, and the secret from the
// safe sources ReadSecretKey resolves (environment here): a flag would put a
// device key in `ps` output and the shell history.
func TestLoadStorageConfigReadsTheKeysFromTheEnvironment(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "envaccess")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "envsecret")
	secret, err := ReadSecretKey("", false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	c, err := LoadStorageConfig("http://x", "b", "p", "", "", secret)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.AccessKey != "envaccess" || c.SecretKey != "envsecret" {
		t.Errorf("keys = %q/%q, want the environment values", c.AccessKey, c.SecretKey)
	}
}

// There is no secret flag to put a key in, so a key cannot be smuggled in as
// one. The refusal names the three safe ways and tells the person the value
// they typed is already exposed by having been in argv.
func TestMountRefusesTheSecretKeyFlag(t *testing.T) {
	for _, args := range [][]string{
		{"--secret-key", "SECRETVALUE", "--endpoint", "http://x", "--bucket", "b"},
		{"--secret-key=SECRETVALUE"},
		{"-secret-key=SECRETVALUE"},
	} {
		err := runMount(args)
		if err == nil {
			t.Errorf("runMount(%q) = nil, want the refusal", args)
			continue
		}
		for _, want := range []string{"--secret-key is not accepted", "DRIVE_S3_SECRET_ACCESS_KEY", "--secret-key-stdin", "rclone.conf"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("runMount(%q) error %q is missing %q", args, err, want)
			}
		}
		if strings.Contains(err.Error(), "SECRETVALUE") {
			t.Errorf("runMount(%q) error %q echoes the value it refused", args, err)
		}
		if !strings.Contains(err.Error(), "roll") {
			t.Errorf("runMount(%q) error %q does not say to roll the key that was in argv", args, err)
		}
	}
}

// There is no flag to put a key in, so a key cannot be smuggled in as one. The
// access key id has no flag either (drive#122): it is read from the environment.
func TestMountRefusesAKeyFlag(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "envaccess")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "envsecret")
	out, err := exec.Command(driveBin(t), "mount",
		"--endpoint", "http://x", "--bucket", "b",
		"--access-key", "leaked", "--dry-run").CombinedOutput()
	if err == nil {
		t.Fatalf("expected a usage error for the removed access-key flag, got:\n%s", out)
	}
	if !strings.Contains(string(out), "flag provided but not defined: -access-key") {
		t.Errorf("expected a flag-not-defined usage error, got:\n%s", out)
	}
}

func TestLoadStorageConfigPrefersFlagsOverEnv(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "a")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "s")
	t.Setenv("DRIVE_S3_ENDPOINT", "http://from-env")
	secret, err := ReadSecretKey("", false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	c, err := LoadStorageConfig("http://from-flag", "b", "p", "", "", secret)
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
			if _, err := LoadStorageConfig(c.Endpoint, c.Bucket, c.Prefix, c.Region, c.DownloadURL, c.SecretKey); err == nil {
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
		if _, err := LoadStorageConfig("http://x", "b", prefix, "", "", "s"); err != nil {
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

// The storage secret has three safe sources and no unsafe one (issue #75).
// Each path is covered here, with the config file's mode, because a secret read
// from a file other users can read is the same leak as a secret in argv.
func TestReadSecretKeyFromStdin(t *testing.T) {
	got, err := ReadSecretKey("", true, strings.NewReader("SECRETFROMSTDIN\n"))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if got != "SECRETFROMSTDIN" {
		t.Errorf("secret = %q, want the piped value with the newline trimmed", got)
	}
}

func TestReadSecretKeyFromEmptyStdinIsAnError(t *testing.T) {
	if _, err := ReadSecretKey("", true, strings.NewReader("  \n")); err == nil {
		t.Fatal("an empty secret on stdin must not read as a missing secret")
	}
}

func TestReadSecretKeyFromTheEnvironment(t *testing.T) {
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "SECRETFROMENV")
	got, err := ReadSecretKey("", false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if got != "SECRETFROMENV" {
		t.Errorf("secret = %q, want the environment value", got)
	}
}

func TestReadSecretKeyFromTheConfigFile(t *testing.T) {
	home := t.TempDir()
	path := RcloneConfigPath(home)
	if err := WriteFileAtomic(path, []byte(RcloneConfig(testStorage())), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	got, err := ReadSecretKey(path, false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if want := testStorage().SecretKey; got != want {
		t.Errorf("secret = %q, want %q from the config file", got, want)
	}
}

func TestReadSecretKeyRefusesAConfigFileOthersCanRead(t *testing.T) {
	home := t.TempDir()
	path := RcloneConfigPath(home)
	// The mode is set explicitly, not left to the writer's default, so the test
	// proves the check and not the other code path's chmod.
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(RcloneConfig(testStorage())), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	info, statErr := os.Stat(path)
	if statErr != nil {
		t.Fatal(statErr)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Fatalf("test setup: mode is %04o, want 644", perm)
	}
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	secret, err := ReadSecretKey(path, false, strings.NewReader(""))
	if err == nil {
		t.Fatal("a world-readable secret file must not be read")
	}
	if secret != "" {
		t.Errorf("secret = %q, want nothing returned with the refusal", secret)
	}
	if !strings.Contains(err.Error(), "644") || !strings.Contains(err.Error(), "chmod 600") {
		t.Errorf("error %q does not name the mode and the fix", err)
	}
}

// Another remote's malformed line is not this CLI's file and not its business:
// only the drive remote is parsed, so a config a person also uses for other
// rclone remotes must not be refused over a line in one of them.
func TestParseRcloneConfigIgnoresOtherRemotes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rclone.conf")
	body := "[other]\nnot a key value line at all\n" + RcloneConfig(testStorage())
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ParseRcloneConfig(path)
	if err != nil {
		t.Fatalf("a malformed line in another remote must not refuse the file: %v", err)
	}
	if got.AccessKey != testStorage().AccessKey || got.SecretKey != testStorage().SecretKey {
		t.Errorf("parsed %+v, want the drive remote's key", got)
	}
}

func TestReadSecretKeyPrefersAnExplicitRequestOverTheEnvironment(t *testing.T) {
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "SECRETFROMENV")
	got, err := ReadSecretKey("", true, strings.NewReader("SECRETFROMSTDIN\n"))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if got != "SECRETFROMSTDIN" {
		t.Errorf("secret = %q, want the value the command asked for", got)
	}
}

func TestReadSecretKeyWithNoSourceIsEmptyNotAnError(t *testing.T) {
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	got, err := ReadSecretKey(RcloneConfigPath(t.TempDir()), false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if got != "" {
		t.Errorf("secret = %q, want empty", got)
	}
}

func TestParseRcloneConfigReadsBackWhatRcloneConfigWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rclone.conf")
	if err := WriteFileAtomic(path, []byte(RcloneConfig(testStorage())), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := ParseRcloneConfig(path)
	if err != nil {
		t.Fatalf("ParseRcloneConfig: %v", err)
	}
	want := testStorage()
	if got.AccessKey != want.AccessKey || got.SecretKey != want.SecretKey ||
		got.Endpoint != want.Endpoint || got.Region != want.Region {
		t.Errorf("round trip = %+v, want the fields RcloneConfig wrote", got)
	}
}

func TestParseRcloneConfigRejectsAFileThatIsNotTheDriveConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rclone.conf")
	if err := os.WriteFile(path, []byte("[other]\naccess_key_id = A\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ParseRcloneConfig(path); err == nil {
		t.Fatal("a config with no [drive] section must not parse as this device's key")
	}
}

func TestParseAPIBaseRefusesCredentialsInTheURL(t *testing.T) {
	if _, err := parseAPIBase("https://user:secretkey@example.com"); err == nil {
		t.Fatal("a URL carrying credentials must be refused: it is a secret on the command line and in every error line that prints it")
	}
}

// The secret flag is the finding this issue opens with. It must be an error
// that names the ways that are safe, not a silently ignored flag — and because
// the typed value is already in this process's argv, the refusal also has to say
// that the key it exposed should be rolled.
func TestParseAPIBaseDoesNotEchoAURLThatCarriesCredentials(t *testing.T) {
	_, err := parseAPIBase("https://user:secretkey@example.com:notaport")
	if err == nil {
		t.Fatal("want an error for a URL that cannot parse")
	}
	if strings.Contains(err.Error(), "secretkey") {
		t.Errorf("error %q carries the credential", err)
	}
	if !strings.Contains(err.Error(), "does not parse") {
		t.Errorf("error %q does not name the fault", err)
	}
}

// Every failure branch of parseAPIBase is a place a URL can leak, not just the
// one the guard checks first: a URL that parses as scheme "user" and opaque
// "password@host" has no User field to inspect. So no branch may echo the
// value at all, and this table proves it for the shapes that have a credential
// in them.
func TestParseAPIBaseNeverEchoesACredential(t *testing.T) {
	for _, raw := range []string{
		"https://user:secretkey@example.com",          // userinfo, parses
		"ftp://user:secretkey@example.com",            // wrong scheme, userinfo
		"http://user:secretkey@",                      // userinfo, no host
		"user:secretkey@example.com",                  // opaque, no User field
		"https://user:secretkey@example.com:notaport", // will not parse
		"https://user:secretkey@example.com/%zz",      // bad escape
	} {
		_, err := parseAPIBase(raw)
		if err == nil {
			t.Errorf("parseAPIBase(%q) = nil, want a refusal", raw)
			continue
		}
		if strings.Contains(err.Error(), "secretkey") {
			t.Errorf("parseAPIBase(%q) leaks the credential: %v", raw, err)
		}
	}
}

// The storage secret is in every request the CLI makes to the Worker, so a
// remote plain-http URL is refused; loopback is where the stand-in and a local
// dev Worker live, and cleartext there never leaves the machine. Every spelling
// of loopback counts, not just the one the first version happened to list.
func TestParseAPIBaseRequiresHTTPSOffLoopback(t *testing.T) {
	if _, err := parseAPIBase("http://example.com"); err == nil {
		t.Error("plain http to a remote host must be refused: the secret would travel in the clear")
	} else if !strings.Contains(err.Error(), "https") {
		t.Errorf("refusal %q does not name the fix", err)
	}
	for _, ok := range []string{
		"http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787",
		"http://127.0.0.2:8787", "http://LOCALHOST:8787", "http://[::ffff:127.0.0.1]:8787",
	} {
		if _, err := parseAPIBase(ok); err != nil {
			t.Errorf("parseAPIBase(%q) = %v, want loopback http allowed", ok, err)
		}
	}
	for _, refused := range []string{"http://10.0.0.5:8787", "http://192.168.1.4", "http://[2001:db8::1]"} {
		if _, err := parseAPIBase(refused); err == nil {
			t.Errorf("parseAPIBase(%q) = nil, want a remote plain-http URL refused", refused)
		}
	}
	if _, err := parseAPIBase("https://api.example.com/"); err != nil {
		t.Errorf("https must be allowed: %v", err)
	}
}

// A config is not required to carry a whole key pair: a secret without the id
// is a half-written file, not a file this CLI did not write, and each caller
// asks for the half it needs.
func TestParseRcloneConfigReportsAPartialKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rclone.conf")
	if err := os.WriteFile(path, []byte("[drive]\nsecret_access_key = ONLYTHESECRET\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := ParseRcloneConfig(path)
	if err != nil {
		t.Fatalf("a config with a secret and no id must still parse: %v", err)
	}
	if c.SecretKey != "ONLYTHESECRET" {
		t.Errorf("SecretKey = %q, want the value the file carries", c.SecretKey)
	}
	// logout needs both, and refuses the half-written file rather than call it
	// this device's key.
	home := t.TempDir()
	if err := os.MkdirAll(DefaultConfigDir(home), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(RcloneConfigPath(home), []byte("[drive]\nsecret_access_key = ONLYTHESECRET\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadDeviceKey(home); err == nil {
		t.Error("ReadDeviceKey must refuse a key id with no secret, or a secret with no id")
	}
}

// A control byte plus userinfo is the shape that could slip a credential past a
// "check first, then print" guard, so it is pinned in the table that proves no
// branch echoes the value.
func TestParseAPIBaseNeverEchoesACredentialWithAControlByte(t *testing.T) {
	for _, raw := range []string{
		"https://user:secretkey@example.com\n",
		"https://user:secretkey@example.com\x00",
	} {
		_, err := parseAPIBase(raw)
		if err == nil {
			t.Errorf("parseAPIBase(%q) = nil, want a refusal", raw)
			continue
		}
		if strings.Contains(err.Error(), "secretkey") {
			t.Errorf("parseAPIBase(%q) leaks the credential: %v", raw, err)
		}
	}
}

// A malformed line can be a bare secret; the error reaches the terminal, so
// the line's contents must not.
func TestParseRcloneConfigDoesNotEchoAMalformedLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rclone.conf")
	if err := os.WriteFile(path, []byte("[drive]\nSECRETBLOBDATA\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := ParseRcloneConfig(path)
	if err == nil {
		t.Fatal("want an error for a line that is not key = value")
	}
	if strings.Contains(err.Error(), "SECRETBLOBDATA") {
		t.Errorf("error %q echoes the line", err)
	}
}

func TestReadSecretKeyRejectsMultiLineStdin(t *testing.T) {
	// Both lines already written, then closed: the second line is sitting in the
	// reader's buffer when the first line is read, so it is caught.
	_, err := ReadSecretKey("", true, strings.NewReader("SECRETONE\nSECRETTWO\n"))
	if err == nil {
		t.Fatal("more than one line on stdin must not become one secret")
	}
	if !strings.Contains(err.Error(), "one line") {
		t.Errorf("error %q does not say what is wrong", err)
	}
}

// The flag reads a line, not the whole pipe. A writer that stays open — a
// process manager, a long-lived producer — must not hang the mount, and the
// test proves the read returns on the newline with the writer still live. A
// second line that is still coming is not waited for: the flag says one line,
// and sitting on an open pipe is the hang this exists to avoid.
func TestReadSecretKeyReturnsOnTheNewlineNotAtEOF(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	go func() {
		// Write the line and deliberately do NOT close: an EOF-only read would
		// block here forever, and this test would time out with a failure
		// rather than pass.
		_, _ = writer.Write([]byte("SECRETFROMANOPENPIPE\n"))
	}()
	got, err := ReadSecretKey("", true, reader)
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if got != "SECRETFROMANOPENPIPE" {
		t.Errorf("secret = %q, want the first line while the writer is still open", got)
	}
}

func TestReadSecretKeyRejectsAnOversizeStdin(t *testing.T) {
	_, err := ReadSecretKey("", true, strings.NewReader(strings.Repeat("a", maxSecretBytes+64)))
	if err == nil {
		t.Fatal("an unbounded pipe must not be read as a secret")
	}
}
