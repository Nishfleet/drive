package main

import (
	"errors"
	"html"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/Nishfleet/drive/internal/atomicwrite"
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

func TestVFSDirCacheTimeIsAtLeastFiveMinutes(t *testing.T) {
	d, err := time.ParseDuration(vfsDirCacheTimeValue)
	if err != nil {
		t.Fatalf("vfsDirCacheTimeValue %q: %v", vfsDirCacheTimeValue, err)
	}
	if d < 5*time.Minute {
		t.Errorf("vfsDirCacheTimeValue = %s (%v), want at least 5m (issue #541)", vfsDirCacheTimeValue, d)
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
	if strings.Contains(got, "no_check_bucket") {
		t.Errorf("a permanent key can HeadBucket, so no_check_bucket must stay off:\n%s", got)
	}
	if strings.Contains(got, "secret_access_key") || strings.Contains(got, testStorage().SecretKey) {
		t.Errorf("rclone.conf must not carry the storage secret:\n%s", got)
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
	if _, err := LoadStorageConfig("", "", "", "", "", "", StorageConfig{}); err == nil {
		t.Fatal("expected an error when no storage config is given")
	} else if !strings.Contains(err.Error(), "missing its storage settings") {
		t.Fatalf("unexpected error text: %v", err)
	}
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "a")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "s")
	secret, err := ReadSecretKey("", false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	c, err := LoadStorageConfig("http://x", "b", "", "", "", secret, StorageConfig{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Region != "us-east-1" {
		t.Errorf("default region = %q, want us-east-1", c.Region)
	}
}

func TestLoadStorageConfigReadsTheKeysFromTheEnvironment(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "envaccess")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "envsecret")
	secret, err := ReadSecretKey("", false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	c, err := LoadStorageConfig("http://x", "b", "p", "", "", secret, StorageConfig{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.AccessKey != "envaccess" || c.SecretKey != "envsecret" {
		t.Errorf("keys = %q/%q, want the environment values", c.AccessKey, c.SecretKey)
	}
}

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
		for _, want := range []string{"--secret-key is not accepted", "DRIVE_S3_SECRET_ACCESS_KEY", "--secret-key-stdin", "rclone.env"} {
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
	c, err := LoadStorageConfig("http://from-flag", "b", "p", "", "", secret, StorageConfig{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if c.Endpoint != "http://from-flag" {
		t.Errorf("endpoint = %q, want the flag value", c.Endpoint)
	}
}

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
			"--dir-cache-time " + vfsDirCacheTimeValue,
			"--vfs-read-chunk-size " + vfsReadChunkSizeValue,
			"--vfs-read-chunk-streams 2",
			"--buffer-size 32M",
			"--transfers 4",
			"--vfs-read-ahead 128k",
		} {
			if !strings.Contains(line, want) {
				t.Errorf("%s: command line missing %q:\n%s", tc.goos, want, line)
			}
		}
		// rclone takes the next argument as the duration when the flag has no value of its own.
		if args := p.Args(); !hasArgPair(args, "--dir-cache-time", vfsDirCacheTimeValue) {
			t.Errorf("%s: --dir-cache-time and %s are not adjacent args:\n%v", tc.goos, vfsDirCacheTimeValue, args)
		}
		if args := p.Args(); !hasArgPair(args, "--vfs-read-ahead", "128k") {
			t.Errorf("%s: --vfs-read-ahead and 128k are not adjacent args:\n%v", tc.goos, args)
		}
		if args := p.Args(); !hasArgPair(args, "--vfs-read-chunk-size", vfsReadChunkSizeValue) {
			t.Errorf("%s: --vfs-read-chunk-size and %s are not adjacent args:\n%v", tc.goos, vfsReadChunkSizeValue, args)
		}
		if args := p.Args(); !hasArgPair(args, "--buffer-size", "32M") {
			t.Errorf("%s: --buffer-size and 32M are not adjacent args:\n%v", tc.goos, args)
		}
		if args := p.Args(); !hasArgPair(args, "--transfers", "4") {
			t.Errorf("%s: --transfers and 4 are not adjacent args:\n%v", tc.goos, args)
		}
		if !strings.Contains(line, "drive:drive-standin/u/1234") {
			t.Errorf("%s: command line missing the device remote:\n%s", tc.goos, line)
		}
	}
}

func TestEnvWithoutDriveS3DropsStorageKeys(t *testing.T) {
	got := envWithoutDriveS3([]string{
		"PATH=/usr/bin",
		"DRIVE_S3_SECRET_ACCESS_KEY=secret",
		"DRIVE_S3_ACCESS_KEY_ID=ak",
		"HOME=/home/test",
	})
	joined := strings.Join(got, ",")
	if strings.Contains(joined, "DRIVE_S3_") {
		t.Errorf("env still carries storage keys: %v", got)
	}
	if !strings.Contains(joined, "PATH=/usr/bin") || !strings.Contains(joined, "HOME=/home/test") {
		t.Errorf("env dropped unrelated keys: %v", got)
	}
}

func TestDevicePlanIsNotAnAgent(t *testing.T) {
	p := BuildMountPlan("linux", "/home/test", "/usr/bin/rclone", testStorage())
	if p.isAgent() || p.EnvPath != "" {
		t.Fatalf("device plan isAgent=%v EnvPath=%q, want a product login item", p.isAgent(), p.EnvPath)
	}
	agent := BuildAgentMountPlan("linux", "/home/test", "/usr/bin/rclone", "claude", testStorage())
	if !agent.isAgent() || agent.EnvPath == "" {
		t.Fatalf("agent plan isAgent=%v EnvPath=%q, want stock rclone", agent.isAgent(), agent.EnvPath)
	}
	if agent.RCAddr != "" || agent.RCUser != "" || agent.RCPass != "" {
		t.Fatalf("agent plan has remote control %q / %q, want none", agent.RCAddr, agent.RCUser)
	}
	argv := agent.productArgv()
	if len(argv) == 0 || argv[0] != "/usr/bin/rclone" {
		t.Fatalf("agent productArgv = %v, want stock rclone first", argv)
	}
}

func TestProductArgsKeepsForegroundOnEveryPlatform(t *testing.T) {
	for _, goos := range []string{"linux", "darwin", "windows"} {
		p := withProductBin(BuildMountPlan(goos, "/home/test", "rclone", testStorage()))
		if goos == "windows" {
			p.MountDir = "Z:"
		}
		args := p.productArgs()
		if !hasArg(args, "--foreground") {
			t.Errorf("%s: productArgs missing --foreground: %v", goos, args)
		}
		if args[0] != "mount" {
			t.Errorf("%s: productArgs[0] = %q, want mount", goos, args[0])
		}
		if !hasArgPair(args, "--rclone", p.RcloneBin) {
			t.Errorf("%s: productArgs missing --rclone %s: %v", goos, p.RcloneBin, args)
		}
	}
}

func withProductBin(p MountPlan) MountPlan {
	switch p.GOOS {
	case "windows":
		p.DriveBin = `C:\Program Files\Drive\drive.exe`
	case "darwin":
		p.DriveBin = "/opt/homebrew/bin/drive"
	default:
		p.DriveBin = "/usr/local/bin/drive"
	}
	return p
}

func TestLaunchdPlistRunsTheProduct(t *testing.T) {
	p := withProductBin(BuildMountPlan("darwin", "/Users/test", "/opt/homebrew/bin/rclone", testStorage()))
	plist := LaunchdPlist(p)
	for _, want := range []string{
		"<string>" + LaunchdLabel + "</string>",
		"<string>/opt/homebrew/bin/drive</string>",
		"<string>mount</string>",
		"<string>--foreground</string>",
		"<string>--home</string>",
		"<string>/Users/test</string>",
		"<true/>",
	} {
		if !strings.Contains(plist, want) {
			t.Errorf("launchd plist missing %q:\n%s", want, plist)
		}
	}
	args := plistProgramArguments(t, plist)
	if len(args) < 6 || args[5] != "/opt/homebrew/bin/drive" {
		t.Errorf("launchd exec target = %v, want this CLI after the umount wrapper", args)
	}
	if hasArg(args, "nfsmount") {
		t.Errorf("launchd plist still execs nfsmount:\n%s", plist)
	}
	if !hasArgPair(args, "--rclone", "/opt/homebrew/bin/rclone") {
		t.Errorf("launchd ProgramArguments missing --rclone of the resolved binary:\n%v", args)
	}
	if !hasArgPair(args, "--home", "/Users/test") || !hasArg(args, "--foreground") {
		t.Errorf("launchd ProgramArguments missing the product command:\n%v", args)
	}
	if p := LaunchdPlistPath("/Users/test"); p != "/Users/test/Library/LaunchAgents/com.nishfleet.drive.plist" {
		t.Errorf("LaunchdPlistPath = %q", p)
	}
}

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

func TestSystemdUnitRunsTheProduct(t *testing.T) {
	p := withProductBin(BuildMountPlan("linux", "/home/test", "/usr/bin/rclone", testStorage()))
	unit := SystemdUnit(p)
	for _, want := range []string{
		"ExecStart=/usr/local/bin/drive mount --foreground --home /home/test --rclone /usr/bin/rclone",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("systemd unit missing %q:\n%s", want, unit)
		}
	}
	if strings.HasPrefix(strings.TrimPrefix(extractExecStart(unit), "ExecStart="), "/usr/bin/rclone") {
		t.Errorf("systemd unit still execs rclone:\n%s", unit)
	}
	if strings.Contains(unit, "Environment=") || strings.Contains(unit, "EnvironmentFile=") {
		t.Errorf("systemd unit must not carry secrets in the unit file:\n%s", unit)
	}
	if strings.Contains(unit, "ExecStop") {
		t.Errorf("systemd unit has an ExecStop line:\n%s", unit)
	}
	execStart := extractExecStart(unit)
	startArgs := strings.Fields(strings.TrimPrefix(execStart, "ExecStart="))
	if !hasArgPair(startArgs, "--home", "/home/test") {
		t.Errorf("ExecStart line missing adjacent --home /home/test:\n%s", execStart)
	}
	if !hasArgPair(startArgs, "--rclone", "/usr/bin/rclone") {
		t.Errorf("ExecStart line missing adjacent --rclone of the resolved binary:\n%s", execStart)
	}
	if p := SystemdUnitPath("/home/test"); p != "/home/test/.config/systemd/user/drive-mount.service" {
		t.Errorf("SystemdUnitPath = %q", p)
	}
}

func TestSystemdUnitClearsADeadFuseEntryBeforeStart(t *testing.T) {
	p := BuildMountPlan("linux", "/home/test", "/usr/bin/rclone", testStorage())
	unit := SystemdUnit(p)
	pre := extractExecStartPre(unit)
	if pre == "" {
		t.Fatalf("systemd unit missing ExecStartPre:\n%s", unit)
	}
	for _, want := range []string{"findmnt", "fuse.rclone", "-uz", "/home/test/Drive", "fusermount3", "fusermount"} {
		if !strings.Contains(pre, want) {
			t.Errorf("ExecStartPre missing %q:\n%s", want, pre)
		}
	}
	if !strings.Contains(pre, "-t fuse.rclone,fuse") {
		t.Errorf("ExecStartPre unmounts without a FUSE type check:\n%s", pre)
	}
}

func extractExecStartPre(unit string) string {
	for _, line := range strings.Split(unit, "\n") {
		if strings.HasPrefix(line, "ExecStartPre=") {
			return line
		}
	}
	return ""
}

func TestLaunchdPlistClearsADeadMountBeforeStart(t *testing.T) {
	p := BuildMountPlan("darwin", "/Users/test", "/opt/homebrew/bin/rclone", testStorage())
	args := plistProgramArguments(t, LaunchdPlist(p))
	if len(args) < 4 || args[0] != "/bin/sh" || args[1] != "-c" {
		t.Fatalf("launchd ProgramArguments = %v, want /bin/sh -c <umount> … rclone", args)
	}
	if !strings.Contains(args[2], "umount") || !strings.Contains(args[2], "-f") {
		t.Errorf("launchd pre-start script = %q, want a forced umount of a dead NFS entry", args[2])
	}
	if strings.Contains(args[2], `umount "$1"`) {
		t.Errorf("launchd pre-start script = %q, want umount -f only: a plain umount hangs on a hard NFS mount", args[2])
	}
	if !strings.Contains(args[2], "mount -t nfs") {
		t.Errorf("launchd pre-start script = %q, want an NFS mount-table check before umount", args[2])
	}
	if args[4] != "/Users/test/Drive" {
		t.Errorf("launchd umount target = %q, want the mount dir", args[4])
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

func hasArgPair(args []string, flag, value string) bool {
	for i, a := range args {
		if a == flag {
			return i+1 < len(args) && args[i+1] == value
		}
	}
	return false
}

func argValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func TestRcloneConfigRendersTheSessionTokenWhenThereIsOne(t *testing.T) {
	c := testStorage()
	if strings.Contains(RcloneConfig(c), "session_token") {
		t.Errorf("a permanent credential must not gain a session_token line:\n%s", RcloneConfig(c))
	}
	c.SessionToken = "FQoGZXIvYXdzEExampleSessionToken"
	got := RcloneConfig(c)
	if !strings.Contains(got, "session_token = "+c.SessionToken) {
		t.Errorf("rclone config missing the session token rclone signs with:\n%s", got)
	}
	if !strings.Contains(got, "no_check_bucket = true") {
		t.Errorf("a scoped key cannot HeadBucket, so rclone must skip the check:\n%s", got)
	}
	// rclone ignores an s3 backend option it does not know and signs without it.
	if !strings.Contains(got, "type = s3") {
		t.Errorf("the session token needs the s3 backend to mean anything:\n%s", got)
	}
	redacted := RcloneConfigRedacted(c)
	if strings.Contains(redacted, c.SessionToken) {
		t.Errorf("redacted config still carries the session token:\n%s", redacted)
	}
	if !strings.Contains(redacted, "session_token = <redacted>") {
		t.Errorf("redacted config missing the redacted session token line:\n%s", redacted)
	}
	path := filepath.Join(t.TempDir(), "rclone.conf")
	if err := WriteFileAtomic(path, []byte(got), 0o600); err != nil {
		t.Fatal(err)
	}
	back, err := ParseRcloneConfig(path)
	if err != nil {
		t.Fatalf("ParseRcloneConfig: %v", err)
	}
	if back.SessionToken != c.SessionToken {
		t.Errorf("ParseRcloneConfig SessionToken = %q, want the token RcloneConfig wrote", back.SessionToken)
	}
}

func TestLoadStorageConfigReadsTheSessionTokenFromTheEnvironment(t *testing.T) {
	t.Setenv("DRIVE_S3_ENDPOINT", "http://127.0.0.1:39181")
	t.Setenv("DRIVE_S3_BUCKET", "drive-standin")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "DRIVETESTACCESSKEY")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "drivetestsecret")
	t.Setenv("DRIVE_S3_SESSION_TOKEN", "envsessiontoken")

	c, err := LoadStorageConfig("", "", "", "", "", "drivetestsecret", StorageConfig{})
	if err != nil {
		t.Fatalf("LoadStorageConfig: %v", err)
	}
	if c.SessionToken != "envsessiontoken" {
		t.Errorf("SessionToken = %q, want the environment's value", c.SessionToken)
	}
	t.Setenv("DRIVE_S3_SESSION_TOKEN", "")
	c, err = LoadStorageConfig("", "", "", "", "", "drivetestsecret", StorageConfig{})
	if err != nil {
		t.Fatalf("LoadStorageConfig without a session token: %v", err)
	}
	if c.SessionToken != "" {
		t.Errorf("SessionToken = %q, want empty", c.SessionToken)
	}
}

func TestLoadStorageConfigRejectsASessionTokenThatWouldInjectAnOption(t *testing.T) {
	t.Setenv("DRIVE_S3_ENDPOINT", "http://127.0.0.1:39181")
	t.Setenv("DRIVE_S3_BUCKET", "drive-standin")
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "DRIVETESTACCESSKEY")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "drivetestsecret")
	t.Setenv("DRIVE_S3_SESSION_TOKEN", "tok\nno_check_certificate = true")
	if _, err := LoadStorageConfig("", "", "", "", "", "drivetestsecret", StorageConfig{}); err == nil {
		t.Fatal("got nil error for a session token that would inject an rclone option")
	} else if !strings.Contains(err.Error(), "session token") {
		t.Errorf("got %q, want it to name the session token", err)
	}
}

func TestRcloneConfigRedactedHidesBothKeys(t *testing.T) {
	c := testStorage()
	got := RcloneConfigRedacted(c)
	if strings.Contains(got, c.AccessKey) || strings.Contains(got, c.SecretKey) {
		t.Errorf("redacted config still carries a key:\n%s", got)
	}
	for _, want := range []string{"access_key_id = <redacted>", c.Endpoint} {
		if !strings.Contains(got, want) {
			t.Errorf("redacted config missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "secret_access_key") {
		t.Errorf("redacted config still names the storage secret:\n%s", got)
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
			t.Setenv("DRIVE_S3_ACCESS_KEY_ID", c.AccessKey)
			t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", c.SecretKey)
			if _, err := LoadStorageConfig(c.Endpoint, c.Bucket, c.Prefix, c.Region, c.DownloadURL, c.SecretKey, StorageConfig{}); err == nil {
				t.Fatal("want an error for a value that breaks out of its config line")
			}
		})
	}
}

func TestLoadStorageConfigAcceptsAPrefixInsideTheDevice(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "a")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "s")
	for _, prefix := range []string{"", "/", "u/1", "/u/1/branches/", "u/1/...hidden"} {
		if _, err := LoadStorageConfig("http://x", "b", prefix, "", "", "s", StorageConfig{}); err != nil {
			t.Errorf("prefix %q rejected: %v", prefix, err)
		}
	}
}

func TestSystemdUnitQuotesForSystemd(t *testing.T) {
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

func TestMountDryRunNeverPrintsAKey(t *testing.T) {
	const access, secret = "DRYRUNACCESSKEY", "dryrun-secret-value"
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", access)
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", secret)
	rclone := writeFakeRclone(t, "rclone v"+MinRcloneVersion+"\n- os/version: test\n")
	out, err := exec.Command(driveBin(t), "mount",
		"--endpoint", "http://127.0.0.1:1", "--bucket", "drive-dry-run",
		"--prefix", "u/dryrun", "--home", t.TempDir(), "--dry-run",
		"--rclone", rclone).CombinedOutput()
	if err != nil {
		t.Fatalf("dry run failed: %v\n%s", err, out)
	}
	if strings.Contains(string(out), secret) {
		t.Errorf("dry-run output carries the secret key:\n%s", out)
	}
	if strings.Contains(string(out), access) {
		t.Errorf("dry-run output carries the access key:\n%s", out)
	}
	printed := string(out)
	if !strings.Contains(printed, "mount --foreground") {
		t.Errorf("dry-run login item does not run the product:\n%s", printed)
	}
	if strings.Contains(printed, "ExecStart="+rclone) {
		t.Errorf("dry-run login item still execs the rclone stand-in:\n%s", printed)
	}
}

// A login item has no shell PATH, so the plan must carry an absolute rclone path rather than a bare name.
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

func TestMountLinuxRestartsAnAlreadyRunningUnit(t *testing.T) {
	got := mountSystemctlActions()
	want := []string{"daemon-reload", "enable", "restart"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("systemctl actions = %v, want %v", got, want)
	}
}

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

func TestReadSecretKeyFromTheEnvFile(t *testing.T) {
	home := t.TempDir()
	cfg := testStorage()
	if err := WriteRcloneEnv(home, cfg, "", "", ""); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	got, err := ReadSecretKey(RcloneConfigPath(home), false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if got != cfg.SecretKey {
		t.Errorf("secret = %q, want %q from rclone.env", got, cfg.SecretKey)
	}
}

func TestReadSecretKeyFromALegacyRcloneConf(t *testing.T) {
	home := t.TempDir()
	path := RcloneConfigPath(home)
	if err := WriteFileAtomic(path, []byte("[drive]\nsecret_access_key = leftover-secret\naccess_key_id = AK\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	got, err := ReadSecretKey(path, false, strings.NewReader(""))
	if err != nil {
		t.Fatalf("ReadSecretKey: %v", err)
	}
	if got != "leftover-secret" {
		t.Errorf("secret = %q, want the leftover rclone.conf line", got)
	}
}

func TestReadSecretKeyRefusesAConfigFileOthersCanRead(t *testing.T) {
	home := t.TempDir()
	path := RcloneConfigPath(home)
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
	if got.AccessKey != testStorage().AccessKey {
		t.Errorf("parsed %+v, want the drive remote's access key", got)
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
	if got.AccessKey != want.AccessKey || got.Endpoint != want.Endpoint || got.Region != want.Region {
		t.Errorf("round trip = %+v, want the fields RcloneConfig wrote", got)
	}
	if got.SecretKey != "" {
		t.Errorf("rclone.conf still carries the storage secret %q", got.SecretKey)
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

func TestParseAPIBaseNeverEchoesACredential(t *testing.T) {
	for _, raw := range []string{
		"https://user:secretkey@example.com",
		"ftp://user:secretkey@example.com",
		"http://user:secretkey@",
		"user:secretkey@example.com",
		"https://user:secretkey@example.com:notaport",
		"https://user:secretkey@example.com/%zz",
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
	_, err := ReadSecretKey("", true, strings.NewReader("SECRETONE\nSECRETTWO\n"))
	if err == nil {
		t.Fatal("more than one line on stdin must not become one secret")
	}
	if !strings.Contains(err.Error(), "one line") {
		t.Errorf("error %q does not say what is wrong", err)
	}
}

func TestReadSecretKeyReturnsOnTheNewlineNotAtEOF(t *testing.T) {
	reader, writer := io.Pipe()
	defer writer.Close()
	go func() {
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

func TestDefaultHomeIsTheOSHomeDirectoryNotTheEnvironment(t *testing.T) {
	orig := userHomeDir
	t.Cleanup(func() { userHomeDir = orig })
	const profile = `C:\Users\Jane`
	userHomeDir = func() (string, error) { return profile, nil }
	t.Setenv("HOME", `/nonexistent/old-home`)
	if got := DefaultHome(); got != profile {
		t.Errorf("DefaultHome() = %q, want the OS's own home %q", got, profile)
	}
}

func TestWindowsBuildWithNoHOMEResolvesTheConfigUnderTheProfile(t *testing.T) {
	orig := userHomeDir
	t.Cleanup(func() { userHomeDir = orig })
	const profile = `C:\Users\Jane`
	userHomeDir = func() (string, error) { return profile, nil }
	t.Setenv("HOME", "")

	home := DefaultHome()
	if home != profile {
		t.Fatalf("DefaultHome() = %q, want %q with HOME unset", home, profile)
	}
	for name, got := range map[string]string{
		"config dir":    DefaultConfigDir(home),
		"cache dir":     DefaultCacheDir(home),
		"credentials":   CredentialsPath(home),
		"rclone config": RcloneConfigPath(home),
		"mount log":     filepath.Join(DefaultConfigDir(home), "mount.log"),
	} {
		if !strings.HasPrefix(got, profile) {
			t.Errorf("%s = %q, want it under the profile %q", name, got, profile)
		}
		if strings.HasPrefix(got, `.`) || strings.HasPrefix(got, `\`) {
			t.Errorf("%s = %q is relative: a task that starts from System32 cannot open it", name, got)
		}
	}
}

func TestWriteFileAtomicSyncsTheBytesAndTheDirectory(t *testing.T) {
	var syncedFiles []string
	var syncedDirs []string
	origFile, origDir := atomicwrite.SyncFile, atomicwrite.SyncDir
	t.Cleanup(func() { atomicwrite.SyncFile, atomicwrite.SyncDir = origFile, origDir })
	atomicwrite.SyncFile = func(f *os.File) error {
		syncedFiles = append(syncedFiles, f.Name())
		return f.Sync()
	}
	atomicwrite.SyncDir = func(dir string) error {
		syncedDirs = append(syncedDirs, dir)
		return nil
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	if err := WriteFileAtomic(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("WriteFileAtomic: %v", err)
	}
	if len(syncedFiles) != 1 {
		t.Fatalf("synced files = %v, want the temp file synced once", syncedFiles)
	}
	if got := filepath.Dir(syncedFiles[0]); got != dir {
		t.Errorf("synced %s, want a sibling of %s", syncedFiles[0], path)
	}
	if len(syncedDirs) != 1 {
		t.Fatalf("synced directories = %v, want one", syncedDirs)
	}
	if syncedDirs[0] != dir {
		t.Errorf("synced directory %q, want the parent of %s", syncedDirs[0], path)
	}
}

func TestWriteFileAtomicNamesTheFileWhenTheSyncRefuses(t *testing.T) {
	origFile := atomicwrite.SyncFile
	t.Cleanup(func() { atomicwrite.SyncFile = origFile })
	atomicwrite.SyncFile = func(*os.File) error { return errors.New("no space left on device") }

	dir := t.TempDir()
	path := filepath.Join(dir, "offline.json")
	err := WriteFileAtomic(path, []byte("{}\n"), 0o600)
	if err == nil {
		t.Fatal("a refused fsync must fail the write: the bytes are not on the disk")
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error %v must name the file that was not saved", err)
	}
	if _, statErr := os.Stat(path); !errors.Is(statErr, os.ErrNotExist) {
		t.Errorf("stat %s = %v, want no file", path, statErr)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("left behind %v", entries)
	}
}

func TestWriteFileAtomicKeepsTheContentsWhenTheDirectorySyncRefuses(t *testing.T) {
	orig := atomicwrite.SyncDir
	t.Cleanup(func() { atomicwrite.SyncDir = orig })
	atomicwrite.SyncDir = func(string) error { return errors.New("i/o error") }

	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.json")
	err := WriteFileAtomic(path, []byte("{}\n"), 0o600)
	if err == nil {
		t.Fatal("an unconfirmed write must fail the command")
	}
	if !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "not confirmed") {
		t.Errorf("error %v must name the file and that its durability is unproven", err)
	}
	got, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("read back: %v", readErr)
	}
	if string(got) != "{}\n" {
		t.Errorf("contents = %q, want the new ones: the rename already happened", got)
	}
}
func TestDefaultHomeIsEmptyWhenTheOSHasNoAnswer(t *testing.T) {
	orig := userHomeDir
	t.Cleanup(func() { userHomeDir = orig })
	userHomeDir = func() (string, error) { return "", errors.New("$HOME is not defined") }
	if got := DefaultHome(); got != "" {
		t.Errorf("DefaultHome = %q, want empty (the same empty the environment read gave)", got)
	}
}
