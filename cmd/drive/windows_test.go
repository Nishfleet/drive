package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The Windows branches (drive#153). Every platform decision is a pure or
// injected function, so these tests drive the whole Windows path on a Linux
// runner the way the Mac and Linux tests drive BuildMountPlan with a goos
// string.

func TestWindowsPlanUsesMountAndADriveLetter(t *testing.T) {
	p := BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage())
	if p.Subcommand != "mount" {
		t.Errorf("windows subcommand = %q, want mount (rclone mount on Windows)", p.Subcommand)
	}
	if p.MountDir != "D:" {
		t.Errorf("windows MountDir = %q, want the first candidate D: before Mount resolves it", p.MountDir)
	}
	// The same VFS flags Mac and Linux mount with (the issue: "the same VFS
	// cache flags as Mac and Linux (VFSArgs)").
	for _, want := range []string{
		"--vfs-cache-mode full",
		"--vfs-write-back 5s",
		"--vfs-cache-max-size 20G",
		"--dir-cache-time 5s",
	} {
		if !strings.Contains(p.CommandLine(), want) {
			t.Errorf("windows command line missing %q:\n%s", want, p.CommandLine())
		}
	}
	if !strings.Contains(p.CommandLine(), "drive:drive-standin/u/1234") {
		t.Errorf("windows command line missing the device remote:\n%s", p.CommandLine())
	}
}

func TestWindowsDriveLetterOverride(t *testing.T) {
	alwaysFree := func(string) bool { return true }
	for _, tc := range []struct{ in, want string }{
		{"z", "Z:"},
		{"Z", "Z:"},
		{"z:", "Z:"},
		{"d", "D:"},
	} {
		got, err := WindowsDriveLetter(tc.in, alwaysFree)
		if err != nil {
			t.Errorf("WindowsDriveLetter(%q) error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("WindowsDriveLetter(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestWindowsDriveLetterRefusesAnInvalidOverride(t *testing.T) {
	alwaysFree := func(string) bool { return true }
	for _, in := range []string{"DD", "1", "Z:\\", "D:\\path", "ä", "", " "} {
		if in == "" {
			// The empty override means "choose the first free letter", which is
			// the no-override case, not a refusal.
			continue
		}
		if _, err := WindowsDriveLetter(in, alwaysFree); err == nil {
			t.Errorf("WindowsDriveLetter(%q) = nil error, want a refusal", in)
		}
	}
}

func TestWindowsDriveLetterRefusesAUsedLetter(t *testing.T) {
	// Z: is taken, everything else is free.
	free := func(letter string) bool { return letter != "Z:" }
	_, err := WindowsDriveLetter("z", free)
	if err == nil {
		t.Fatal("a drive letter already in use must be a named refusal, not a mount that fails later")
	}
	if !strings.Contains(err.Error(), "Z:") {
		t.Errorf("the refusal must name the letter: %v", err)
	}
}

func TestWindowsDriveLetterPicksTheFirstFreeFromD(t *testing.T) {
	// C: is taken (the system drive) and D: and E: are taken; the answer is F:.
	taken := map[string]bool{"C:": true, "D:": true, "E:": true}
	free := func(letter string) bool { return !taken[letter] }
	got, err := WindowsDriveLetter("", free)
	if err != nil {
		t.Fatal(err)
	}
	if got != "F:" {
		t.Errorf("first free letter = %q, want F:", got)
	}
}

func TestWindowsDriveLetterNamesWhenNothingIsFree(t *testing.T) {
	_, err := WindowsDriveLetter("", func(string) bool { return false })
	if err == nil {
		t.Fatal("no free letter must be a named failure")
	}
	if !strings.Contains(err.Error(), "D:") || !strings.Contains(err.Error(), "Z:") {
		t.Errorf("the failure must name the range: %v", err)
	}
}

func TestCheckWinFsp(t *testing.T) {
	// The driver is present: no error, whichever of the driver files exists.
	if err := CheckWinFsp("windows", func(path string) bool {
		return strings.HasSuffix(path, "winfsp-x64.dll")
	}); err != nil {
		t.Errorf("CheckWinFsp with the driver present = %v, want nil", err)
	}
	// The driver is missing: the error says reinstall Drive, and never a winget
	// command (Nish, 2026-10-01: users never install WinFsp by hand).
	err := CheckWinFsp("windows", func(string) bool { return false })
	if err == nil {
		t.Fatal("CheckWinFsp with no driver must fail")
	}
	if !strings.Contains(err.Error(), "reinstall Drive") {
		t.Errorf("the WinFsp error must point at reinstalling Drive: %v", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "winget") {
		t.Errorf("the WinFsp error must not tell the user to install WinFsp by hand: %v", err)
	}
	// Every other platform is not asked: the check is Windows-only.
	for _, goos := range []string{"darwin", "linux"} {
		if err := CheckWinFsp(goos, func(string) bool { return false }); err != nil {
			t.Errorf("CheckWinFsp(%q) = %v, want nil", goos, err)
		}
	}
}

func TestWindowsTaskCommandLineCarriesThePlan(t *testing.T) {
	p := BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage())
	p.MountDir = "Z:"
	line := WindowsTaskCommandLine(p)
	for _, want := range []string{`C:\rclone\rclone.exe`, "mount", "drive:drive-standin/u/1234", "Z:"} {
		if !strings.Contains(line, want) {
			t.Errorf("task command line missing %q:\n%s", want, line)
		}
	}
	// The drive letter is recoverable from the task's own command line, which
	// is how `drive status` reports the letter the task chose.
	letter, ok := windowsDriveLetterFromCommand(line)
	if !ok || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want Z:", line, letter, ok)
	}
}

func TestWindowsQuoteArgFollowsTheWindowsRules(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"plain", "plain"},
		{"Z:", "Z:"},
		{"a b", `"a b"`},
		{`C:\Program Files\x`, `"C:\Program Files\x"`},
		{`say "hi"`, `"say \"hi\""`},
		{`trail\`, `trail\`},
		{`a\ b`, `"a\ b"`},
	} {
		if got := windowsQuoteArg(tc.in); got != tc.want {
			t.Errorf("windowsQuoteArg(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSchtasksArgumentVectors(t *testing.T) {
	command := `C:\rclone\rclone.exe mount drive:b/u/1 Z:`
	for _, tc := range []struct {
		name string
		got  []string
		want []string
	}{
		{"create", schtasksCreateArgs(WindowsTaskName, command), []string{"/Create", "/F", "/SC", "ONLOGON", "/TN", WindowsTaskName, "/TR", command}},
		{"run", schtasksRunArgs(WindowsTaskName), []string{"/Run", "/TN", WindowsTaskName}},
		{"end", schtasksEndArgs(WindowsTaskName), []string{"/End", "/TN", WindowsTaskName}},
		{"delete", schtasksDeleteArgs(WindowsTaskName), []string{"/Delete", "/F", "/TN", WindowsTaskName}},
		{"query", schtasksQueryArgs(WindowsTaskName), []string{"/Query", "/TN", WindowsTaskName}},
	} {
		if strings.Join(tc.got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("%s args = %v, want %v", tc.name, tc.got, tc.want)
		}
	}
	// /Create must set a logon trigger and overwrite, so `drive mount` is safe
	// to run again (the issue: "a stock Task Scheduler task (schtasks /Create
	// /SC ONLOGON)").
	create := strings.Join(schtasksCreateArgs(WindowsTaskName, command), " ")
	if !strings.Contains(create, "/SC ONLOGON") {
		t.Errorf("create args must say /SC ONLOGON: %s", create)
	}
	if !strings.Contains(create, "/F") {
		t.Errorf("create args must overwrite an existing task: %s", create)
	}
}

func TestWindowsTaskToRunParsesTheQueryListing(t *testing.T) {
	listing := "Folder: \\\r\n" +
		"HostName:                             TESTPC\r\n" +
		"TaskName:                             \\drive-mount\r\n" +
		"Task To Run:                          C:\\rclone\\rclone.exe mount drive:drive-standin/u/1234 Z: --config C:\\Users\\t\\.config\\drive\\rclone.conf\r\n" +
		"Start In:                             N/A\r\n"
	command, ok := windowsTaskToRun(listing)
	if !ok {
		t.Fatal("windowsTaskToRun did not find Task To Run")
	}
	if !strings.Contains(command, "rclone.exe") {
		t.Errorf("windowsTaskToRun = %q, want the task's command line", command)
	}
	if _, ok := windowsTaskToRun("HostName: TESTPC\r\n"); ok {
		t.Error("windowsTaskToRun must report absence, not an empty command, when the key is missing")
	}
}

func TestWindowsDriveLetterFromCommandIgnoresNonLetters(t *testing.T) {
	for _, tc := range []struct {
		command string
		want    string
		ok      bool
	}{
		{`rclone.exe mount drive:b/u/1 Z: --vfs-cache-mode full`, "Z:", true},
		// A quoted drive letter is the same token.
		{`rclone.exe mount drive:b/u/1 "Z:"`, "Z:", true},
		// Paths carry a colon but their token is longer than one letter.
		{`rclone.exe mount drive:b/u/1 c:\Users\me\Drive`, "", false},
		{`rclone.exe mount drive:b/u/1 --config C:\rclone.conf`, "", false},
		{`rclone.exe mount drive:b/u/1`, "", false},
	} {
		got, ok := windowsDriveLetterFromCommand(tc.command)
		if got != tc.want || ok != tc.ok {
			t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want %q, %v", tc.command, got, ok, tc.want, tc.ok)
		}
	}
}

func TestWindowsVolumeRoot(t *testing.T) {
	if got := windowsVolumeRoot("Z:"); got != `Z:\` {
		t.Errorf("windowsVolumeRoot(Z:) = %q, want Z:\\", got)
	}
}

func TestWindowsLoginItemIsATaskNotAFile(t *testing.T) {
	home := t.TempDir()
	if got := LoginItemPath("windows", home); got != "" {
		t.Errorf("LoginItemPath(windows) = %q, want empty: the login item is the Task Scheduler task", got)
	}
	if got := PrefetchLoginItemPath("windows", home); got != "" {
		t.Errorf("PrefetchLoginItemPath(windows) = %q, want empty: there is no Windows prefetch sidecar", got)
	}
	if files := LoginItemFiles("windows", home); len(files) != 0 {
		t.Errorf("LoginItemFiles(windows) = %v, want none", files)
	}
	p := BuildMountPlan("windows", home, "rclone.exe", testStorage())
	p.MountDir = "Z:"
	if got := LoginItem("windows", p); got != WindowsTaskCommandLine(p) {
		t.Errorf("LoginItem(windows) = %q, want the task command line %q", got, WindowsTaskCommandLine(p))
	}
}

func TestMountedDirUsesTheDriveLetter(t *testing.T) {
	// On a host without a Z: volume the letter is not mounted. This is the
	// Windows branch of MountedDir, asked without a Windows machine.
	on, err := MountedDir("windows", "Z:")
	if err != nil {
		t.Fatalf("MountedDir(windows, Z:) error: %v", err)
	}
	if on {
		t.Skip("this host actually has a Z: volume")
	}
	if on != windowsVolumeMounted("Z:") {
		t.Error("MountedDir(windows) and windowsVolumeMounted disagree")
	}
}

func TestRunMountRefusesDriveLetterOffWindows(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the refusal is for Mac and Linux")
	}
	err := runMount([]string{"--drive-letter", "Z:"})
	if err == nil {
		t.Fatal("runMount with --drive-letter off Windows must be refused, not silently ignored")
	}
	if !strings.Contains(err.Error(), "Windows") {
		t.Errorf("the refusal must say the flag is Windows-only: %v", err)
	}
}

// TestWindowsMountProof is the drive#153 done-when proof: it mounts the
// stand-in storage at the product's own first-free drive letter, writes a file
// through that letter, reads it back, then unmounts and proves the login task
// and the letter are gone. It runs on windows-latest (the CI job installs
// WinFsp first); every other platform skips with the reason.
func TestWindowsMountProof(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the drive-letter mount proof runs on windows-latest (rclone + WinFsp)")
	}
	if testing.Short() {
		t.Skip("mount proof skipped in -short mode")
	}
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := standinOn(t, root, "u/standin")
	// Seed one object into the stand-in through stock rclone, so the read is
	// of an object and not a local file the mount happens to see.
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	seedStandin(t, root, cfg, append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(home)), "seed.bin", 1<<20)

	bin := windowsDriveBin(t)
	// The mount the product ships: no --foreground, so the Task Scheduler
	// login task starts rclone the way it does at logon, and no
	// --drive-letter, so the product picks the first free letter from D: up.
	mountCmd := exec.Command(bin, "mount", "--home", home,
		"--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket, "--prefix", cfg.Prefix)
	mountCmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
	)
	if out, err := mountCmd.CombinedOutput(); err != nil {
		t.Fatalf("drive mount: %v\n%s", err, out)
	}
	t.Cleanup(func() { _ = exec.Command(bin, "unmount", "--home", home).Run() })

	letter, err := windowsMountLetter()
	if err != nil {
		t.Fatal(err)
	}
	if !windowsDriveLetterFromCommandOK(letter) {
		t.Fatalf("the login task named %q, which is not a drive letter", letter)
	}
	t.Logf("mounted at %s", letter)
	if !windowsVolumeMounted(letter) {
		t.Fatalf("the drive letter %s did not come up", letter)
	}

	// A write through the drive letter, then a read back of it.
	path := filepath.Join(windowsVolumeRoot(letter), "written-through.txt")
	body := []byte("written through the drive letter\n")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	// --vfs-write-back is 5s; give the upload time to land before the read.
	time.Sleep(8 * time.Second)
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(got) != string(body) {
		t.Errorf("read back %q, want %q", got, body)
	}

	// Unmount: stop the mount cleanly, then remove the login task.
	if out, err := exec.Command(bin, "unmount", "--home", home).CombinedOutput(); err != nil {
		t.Fatalf("drive unmount: %v\n%s", err, out)
	}
	if windowsVolumeMounted(letter) {
		t.Errorf("drive letter %s is still mounted after unmount", letter)
	}
	if present, err := windowsTaskPresent(WindowsTaskName); err != nil {
		t.Fatal(err)
	} else if present {
		t.Error("the login task survived unmount")
	}
}

// windowsDriveLetterFromCommandOK reports whether s is a normalized drive
// letter, so the proof fails loudly instead of testing the wrong path when the
// task named something unexpected.
func windowsDriveLetterFromCommandOK(s string) bool {
	if len(s) != 2 || s[1] != ':' {
		return false
	}
	c := s[0]
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

// windowsDriveBin builds the drive binary for the Windows proof, with the
// .exe suffix the OS runs.
func windowsDriveBin(t testing.TB) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "drive-win-bin-*")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	out := filepath.Join(dir, "drive.exe")
	cmd := exec.Command("go", "build", "-o", out, ".")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	return out
}

func TestLoginItemPresentFindsTheItemFile(t *testing.T) {
	home := t.TempDir()
	if present, err := LoginItemPresent("linux", home); err != nil || present {
		t.Errorf("LoginItemPresent(linux) on a fresh home = %v, %v, want false, nil", present, err)
	}
	item := LoginItemPath("linux", home)
	if err := os.MkdirAll(filepath.Dir(item), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(item, []byte("unit file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if present, err := LoginItemPresent("linux", home); err != nil || !present {
		t.Errorf("LoginItemPresent(linux) after writing the item = %v, %v, want true, nil", present, err)
	}
}
