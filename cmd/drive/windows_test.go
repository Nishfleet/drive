package main

import (
	"encoding/xml"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestWindowsPlanUsesMountAndADriveLetter(t *testing.T) {
	p := BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage())
	if p.Subcommand != "mount" {
		t.Errorf("windows subcommand = %q, want mount (rclone mount on Windows)", p.Subcommand)
	}
	if p.MountDir != "D:" {
		t.Errorf("windows MountDir = %q, want the first candidate D: before Mount resolves it", p.MountDir)
	}
	for _, want := range []string{
		"--vfs-cache-mode full",
		"--vfs-write-back 5s",
		"--vfs-cache-max-size 20G",
		"--dir-cache-time " + vfsDirCacheTimeValue,
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
			continue
		}
		if _, err := WindowsDriveLetter(in, alwaysFree); err == nil {
			t.Errorf("WindowsDriveLetter(%q) = nil error, want a refusal", in)
		}
	}
}

func TestWindowsDriveLetterRefusesAUsedLetter(t *testing.T) {
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
	if err := CheckWinFsp("windows", func(path string) bool {
		return strings.HasSuffix(path, "winfsp-x64.dll")
	}); err != nil {
		t.Errorf("CheckWinFsp with the driver present = %v, want nil", err)
	}
	err := CheckWinFsp("windows", func(string) bool { return false })
	if err == nil {
		t.Fatal("CheckWinFsp with no driver must fail")
	}
	if !strings.Contains(err.Error(), "reinstall Storagebun") {
		t.Errorf("the WinFsp error must point at reinstalling Storagebun: %v", err)
	}
	if strings.Contains(strings.ToLower(err.Error()), "winget") {
		t.Errorf("the WinFsp error must not tell the user to install WinFsp by hand: %v", err)
	}
	for _, goos := range []string{"darwin", "linux"} {
		if err := CheckWinFsp(goos, func(string) bool { return false }); err != nil {
			t.Errorf("CheckWinFsp(%q) = %v, want nil", goos, err)
		}
	}
}

func TestWindowsTaskCommandLineCarriesThePlan(t *testing.T) {
	p := withProductBin(BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage()))
	p.MountDir = "Z:"
	line := WindowsTaskCommandLine(p)
	for _, want := range []string{`C:\Program Files\Drive\drive.exe`, "mount", "--foreground", "--home", `C:\Users\test`, "Z:"} {
		if !strings.Contains(line, want) {
			t.Errorf("task command line missing %q:\n%s", want, line)
		}
	}
	if !strings.Contains(line, `--rclone C:\rclone\rclone.exe`) {
		t.Errorf("task command line missing --rclone of the resolved binary:\n%s", line)
	}
	if strings.HasPrefix(strings.TrimPrefix(line, `"`), `C:\rclone\rclone.exe`) {
		t.Errorf("task command line still execs rclone:\n%s", line)
	}
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
	xmlPath := `C:\Users\test\.config\drive\login-task.xml`
	for _, tc := range []struct {
		name string
		got  []string
		want []string
	}{
		{"create", schtasksCreateXMLArgs(WindowsTaskName, xmlPath), []string{"/Create", "/F", "/TN", WindowsTaskName, "/XML", xmlPath}},
		{"run", schtasksRunArgs(WindowsTaskName), []string{"/Run", "/TN", WindowsTaskName}},
		{"end", schtasksEndArgs(WindowsTaskName), []string{"/End", "/TN", WindowsTaskName}},
		{"delete", schtasksDeleteArgs(WindowsTaskName), []string{"/Delete", "/F", "/TN", WindowsTaskName}},
		{"query", schtasksQueryArgs(WindowsTaskName), []string{"/Query", "/TN", WindowsTaskName}},
	} {
		if strings.Join(tc.got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("%s args = %v, want %v", tc.name, tc.got, tc.want)
		}
	}
	create := strings.Join(schtasksCreateXMLArgs(WindowsTaskName, xmlPath), " ")
	if !strings.Contains(create, "/F") {
		t.Errorf("create args must overwrite an existing task: %s", create)
	}
	if !strings.Contains(create, "/XML") {
		t.Errorf("create args must register the task from its XML: %s", create)
	}
	if strings.Contains(create, "/TR") {
		t.Errorf("create args must never carry /TR again: /TR holds 261 characters and the task's command line is longer: %s", create)
	}
}

func TestWindowsTaskXMLCarriesThePlan(t *testing.T) {
	p := withProductBin(BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage()))
	p.MountDir = "Z:"
	body, err := windowsTaskXML(p, `DESKTOP\test`)
	if err != nil {
		t.Fatal(err)
	}
	var doc taskXML
	if err := xml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatalf("the task XML does not parse: %v\n%s", err, body)
	}
	if !strings.HasPrefix(body, xml.Header) {
		t.Errorf("the task XML must start with the declaration, got:\n%.40s", body)
	}
	if doc.XMLNS != "http://schemas.microsoft.com/windows/2004/02/mit/task" {
		t.Errorf("task XMLNS = %q, want the Task Scheduler 2.0 namespace", doc.XMLNS)
	}
	if doc.Version != "1.2" {
		t.Errorf("task XML version = %q, want 1.2", doc.Version)
	}
	if doc.Actions.Exec.Command != p.productArgv()[0] {
		t.Errorf("Exec Command = %q, want productArgv[0] %q", doc.Actions.Exec.Command, p.productArgv()[0])
	}
	for _, want := range []string{"mount", "--foreground", "--home", `C:\Users\test`, "--drive-letter", "Z:", "--rclone", `C:\rclone\rclone.exe`} {
		if !strings.Contains(doc.Actions.Exec.Arguments, want) {
			t.Errorf("Exec Arguments missing %q:\n%s", want, doc.Actions.Exec.Arguments)
		}
	}
	if !doc.Triggers.LogonTrigger.Enabled {
		t.Error("the logon trigger must be enabled: it is what /SC ONLOGON did")
	}
	if doc.Triggers.LogonTrigger.UserId != `DESKTOP\test` {
		t.Errorf("LogonTrigger UserId = %q, want the user who mounted", doc.Triggers.LogonTrigger.UserId)
	}
	if doc.Principals.Principal.LogonType != "InteractiveToken" {
		t.Errorf("LogonType = %q, want InteractiveToken: the mount runs in the logged-on session", doc.Principals.Principal.LogonType)
	}
	if doc.Principals.Principal.UserId != `DESKTOP\test` {
		t.Errorf("Principal UserId = %q, want the user who mounted", doc.Principals.Principal.UserId)
	}
	if doc.Triggers.LogonTrigger.UserId != doc.Principals.Principal.UserId {
		t.Errorf("the logon trigger fires for %q but the principal names %q: they must be one account",
			doc.Triggers.LogonTrigger.UserId, doc.Principals.Principal.UserId)
	}
	if doc.Settings.ExecutionTimeLimit != "PT0S" {
		t.Errorf("ExecutionTimeLimit = %q, want PT0S (no time limit): a mount killed by the default is a drive that vanishes after 3 days", doc.Settings.ExecutionTimeLimit)
	}
	toRun := doc.Actions.Exec.Command + " " + doc.Actions.Exec.Arguments
	if letter, ok := windowsDriveLetterFromCommand(toRun); !ok || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want Z:", toRun, letter, ok)
	}
}

func TestWindowsTaskXMLStaysInsideSchtasksLimits(t *testing.T) {
	p := withProductBin(BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage()))
	p.MountDir = "Z:"
	xmlPath := windowsTaskXMLPath(p)
	if len(xmlPath) > 261 {
		t.Errorf("the /XML path is %d characters, over the 261 a schtasks path argument holds: %s", len(xmlPath), xmlPath)
	}
	body, err := windowsTaskXML(p, `DESKTOP\test`)
	if err != nil {
		t.Fatal(err)
	}
	var doc taskXML
	if err := xml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatalf("the task XML does not parse: %v\n%s", err, body)
	}
	if len(doc.Actions.Exec.Command) > 261 {
		t.Errorf("the Exec Command is %d characters, over the 261 the task-to-run path is held to: %s", len(doc.Actions.Exec.Command), doc.Actions.Exec.Command)
	}
	if len(doc.Actions.Exec.Arguments) > 32767 {
		t.Errorf("the Exec Arguments are %d characters, over the 32 K the Task Scheduler API holds them to: %s", len(doc.Actions.Exec.Arguments), doc.Actions.Exec.Arguments)
	}
	for _, arg := range schtasksCreateXMLArgs(WindowsTaskName, xmlPath) {
		if arg == "/TR" {
			t.Error("the create vector carries /TR: /TR holds 261 characters and the task's command line is longer; register the task from its XML")
		}
	}
	if doc.Principals.Principal.UserId == "" {
		t.Error("the principal names no UserId: Task Scheduler refuses an XML whose principal has no account")
	}
	if len(doc.Principals.Principal.UserId) > 261 {
		t.Errorf("the principal UserId is %d characters, over the 261 the field holds: %s",
			len(doc.Principals.Principal.UserId), doc.Principals.Principal.UserId)
	}
}

func TestWindowsSchtasksQuotedKeepsASpacedPathWhole(t *testing.T) {
	xmlPath := `C:\Users\Jane Doe\.config\drive\login-task.xml`
	got := windowsSchtasksQuoted(schtasksCreateXMLArgs(WindowsTaskName, xmlPath)...)
	want := "schtasks /Create /F /TN " + WindowsTaskName + ` /XML "` + xmlPath + `"`
	if got != want {
		t.Errorf("windowsSchtasksQuoted() =\n%s\nwant\n%s", got, want)
	}
	plain := windowsSchtasksQuoted(schtasksCreateXMLArgs(WindowsTaskName, `C:\drive\login-task.xml`)...)
	if strings.Contains(plain, `"`) {
		t.Errorf("a path with no space should not be quoted: %s", plain)
	}
}

func TestWindowsTaskXMLImportsIntoSchtasks(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the schtasks import proof runs on windows-latest, where schtasks is on PATH")
	}
	if testing.Short() {
		t.Skip("schtasks import proof skipped in -short mode")
	}
	if _, err := exec.LookPath("schtasks"); err != nil {
		t.Fatalf("schtasks is not on PATH, so the windows-latest job cannot register the task: %v", err)
	}
	home := `C:\Users\` + strings.Repeat("very-long-profile-name-", 12) + `\drive-home`
	c := testStorage()
	c.Bucket = "bucket"
	c.Prefix = "u/" + strings.Repeat("deep-folder-name/", 12) + "1234"
	p := withProductBin(BuildMountPlan("windows", home, `C:\rclone\rclone.exe`, c))
	p.MountDir = "Z:"
	userName, err := windowsTaskUser()
	if err != nil {
		t.Fatal(err)
	}
	body, err := windowsTaskXML(p, userName)
	if err != nil {
		t.Fatal(err)
	}
	commandLine := WindowsTaskCommandLine(p)
	if !strings.Contains(commandLine, p.DriveBin) {
		t.Fatalf("the command line does not run the product: %s", commandLine)
	}
	if len(commandLine) <= 261 {
		t.Fatalf("command line is %d characters, want over the 261 /TR limit so the XML path stays the only way to register it", len(commandLine))
	}
	xmlPath := windowsTaskXMLPath(p)
	if err := WriteFileAtomic(xmlPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runSchtasks(schtasksCreateXMLArgs("drive-mount-368-test", xmlPath)...); err != nil {
		t.Fatalf("schtasks /Create /XML: %v\n%s", err, body)
	}
	t.Cleanup(func() { _ = runSchtasks(schtasksDeleteArgs("drive-mount-368-test")...) })
	command, ok, err := windowsTaskCommand("drive-mount-368-test")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("schtasks /Query /V found no Task To Run, so the XML registered a task with no command")
	}
	if letter, found := windowsDriveLetterFromCommand(command); !found || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want Z:", command, letter, found)
	}
	if !strings.Contains(command, p.DriveBin) {
		t.Errorf("Task To Run is missing the drive CLI:\n%s", command)
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
		{`rclone.exe mount drive:b/u/1 "Z:"`, "Z:", true},
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
	p := withProductBin(BuildMountPlan("windows", home, "rclone.exe", testStorage()))
	p.MountDir = "Z:"
	if got := LoginItem("windows", p); got != WindowsTaskCommandLine(p) {
		t.Errorf("LoginItem(windows) = %q, want the task command line %q", got, WindowsTaskCommandLine(p))
	}
}

func TestMountedDirUsesTheDriveLetter(t *testing.T) {
	for _, spell := range []string{"Z:", "Z:\\", "z:", "z:\\"} {
		got, err := MountedDir("windows", spell)
		if err != nil {
			t.Fatalf("MountedDir(windows, %q) error: %v", spell, err)
		}
		if got != windowsVolumeMounted("Z:") {
			t.Errorf("MountedDir(windows, %q) = %v, want %v (the volume-root normalization)", spell, got, windowsVolumeMounted("Z:"))
		}
	}
	if windowsVolumeRoot("Z:") != `Z:\` || windowsVolumeRoot("Z:\\") != `Z:\` {
		t.Errorf("windowsVolumeRoot must normalize to the bare root Z:\\")
	}
	if windowsVolumeRoot("Z:") == "Z:" {
		t.Error("windowsVolumeRoot must not return the drive-relative Z:, which is what this normalization exists to prevent")
	}
}

func TestWindowsRcloneMountLettersReadsTheProcessList(t *testing.T) {
	rows := strings.Join([]string{
		`"rclone.exe","4242","Console","1","25,000 K"`,
		`"rclone.exe","4242","Console","1","25,000 K"`,
	}, "\r\n")
	if letter, ok := windowsDriveLetterFromCommand(rows); ok {
		t.Errorf("windowsDriveLetterFromCommand on a process list must not find a letter, got %q", letter)
	}
	row := `"rclone.exe","4242","Console","1","25,000 K" mount drive:drive-standin/u/1 Z: --config C:\Users\t\.config\drive\rclone.conf`
	if letter, ok := windowsDriveLetterFromCommand(row); !ok || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want Z:, true", row, letter, ok)
	}
}

func TestWindowsRcloneMountLettersIsWindowsOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("tasklist exists on Windows")
	}
	if _, err := windowsRcloneMountLetters(); err == nil {
		t.Error("windowsRcloneMountLetters off Windows must be an error, not an empty list")
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

func TestWindowsTaskUserPrefersTheSessionDomain(t *testing.T) {
	t.Setenv("USERDOMAIN", "DESKTOP")
	t.Setenv("USERNAME", "test")
	got, err := windowsTaskUser()
	if err != nil {
		t.Fatal(err)
	}
	if got != `DESKTOP\test` {
		t.Errorf("windowsTaskUser() = %q, want DESKTOP\\test", got)
	}
	t.Setenv("USERDOMAIN", "")
	t.Setenv("USERNAME", "")
	got, err = windowsTaskUser()
	if err != nil {
		t.Fatal(err)
	}
	if got == "" {
		t.Error("windowsTaskUser() with no session variables = empty, want the token's user")
	}
}

func TestWindowsMountProof(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("the drive-letter mount proof runs on windows-latest (rclone + WinFsp)")
	}
	if testing.Short() {
		t.Skip("mount proof skipped in -short mode")
	}
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Fatalf("rclone is not on PATH, so the windows-latest job's rclone install step broke: %v", err)
	}
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, _ := standinOn(t, root, "u/standin")
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	seedStandin(t, root, cfg, append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(home), rcloneSecretEnv+"="+cfg.SecretKey), "seed.bin", 1<<20)

	bin := windowsDriveBin(t)
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

	path := filepath.Join(windowsVolumeRoot(letter), "written-through.txt")
	body := []byte("written through the drive letter\n")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	time.Sleep(8 * time.Second)
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(got) != string(body) {
		t.Errorf("read back %q, want %q", got, body)
	}

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

func windowsDriveLetterFromCommandOK(s string) bool {
	if len(s) != 2 || s[1] != ':' {
		return false
	}
	c := s[0]
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

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

func TestWindowsTaskXMLCarriesAWorkingDirectory(t *testing.T) {
	p := withProductBin(BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage()))
	p.MountDir = "Z:"
	body, err := windowsTaskXML(p, `DESKTOP\test`)
	if err != nil {
		t.Fatal(err)
	}
	var doc taskXML
	if err := xml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatalf("the task XML does not parse: %v\n%s", err, body)
	}
	wantDir := filepath.Join(DefaultConfigDir(`C:\Users\test`))
	if doc.Actions.Exec.WorkingDirectory != wantDir {
		t.Errorf("WorkingDirectory = %q, want the drive's config folder %q",
			doc.Actions.Exec.WorkingDirectory, wantDir)
	}
	for name, path := range map[string]string{
		"--config":    p.ConfigPath,
		"--cache-dir": p.CacheDir,
		"--log-file":  p.LogPath,
	} {
		var derived string
		switch name {
		case "--cache-dir":
			derived = DefaultCacheDir(p.Home)
		case "--log-file":
			derived = filepath.Join(DefaultConfigDir(p.Home), "mount.log")
		default:
			derived = RcloneConfigPath(p.Home)
		}
		if path != derived {
			t.Errorf("%s = %q, want the path the product derives from --home %q: %q", name, path, p.Home, derived)
		}
		if !strings.HasPrefix(path, `C:\Users\test`) {
			t.Errorf("%s = %q: an absolute path under the profile, not %q", name, path, strings.TrimPrefix(path, `C:\Users\test`))
		}
		if strings.HasPrefix(path, `\`) || strings.HasPrefix(path, ".") {
			t.Errorf("%s = %q is relative: the login task starts from System32", name, path)
		}
	}
	args := p.productArgs()
	if len(args) == 0 || args[0] != "mount" {
		t.Fatalf("the login task runs %v, want the product's mount command", args)
	}
	for i, a := range args {
		if strings.HasPrefix(a, "--") {
			continue
		}
		if strings.HasPrefix(a, `\`) || strings.HasPrefix(a, ".") {
			t.Errorf("login task argument %d (%q, after %q) is relative: the action starts from System32", i, a, args[i-1])
		}
	}
	for _, flag := range []string{"--home", "--rclone"} {
		value := flagValue(args, flag)
		if value == "" {
			t.Fatalf("login task arguments carry no %s: %v", flag, args)
		}
		if !windowsAbs(value) {
			t.Errorf("%s %q is not an absolute path the login task can open from System32", flag, value)
		}
		if !strings.Contains(doc.Actions.Exec.Arguments, windowsQuoteArg(value)) {
			t.Errorf("Exec Arguments missing %s (%s):\n%s", flag, windowsQuoteArg(value), doc.Actions.Exec.Arguments)
		}
	}
}

func flagValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func windowsAbs(path string) bool {
	if len(path) >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/') {
		c := path[0]
		return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
	}
	return strings.HasPrefix(path, `\\`)
}

func windowsMountSeams(t *testing.T, up bool) (*[]string, *bool) {
	t.Helper()
	var actions []string
	mounted := up
	origFsp, origSchtasks, origState, origProbe := winFspCheck, runSchtasks, mountState, waitProbe
	winFspCheck = func(string, func(string) bool) error { return nil }
	runSchtasks = func(args ...string) error {
		actions = append(actions, strings.Join(args, " "))
		return nil
	}
	mountState = func(string, string) (bool, error) { return mounted, nil }
	waitProbe = func(string, string) (bool, error) { return true, nil }
	t.Cleanup(func() {
		winFspCheck, runSchtasks, mountState, waitProbe = origFsp, origSchtasks, origState, origProbe
	})
	return &actions, &mounted
}

func windowsMountOnce(t *testing.T, home string, c StorageConfig) string {
	t.Helper()
	t.Setenv("USERDOMAIN", "DRIVE")
	t.Setenv("USERNAME", "test")
	return captureStdout(t, func() {
		if err := Mount("windows", home, "rclone.exe", c, false, false, "Z:"); err != nil {
			t.Fatal(err)
		}
	})
}

func TestWindowsMountSkipsRestartWhenNothingChanged(t *testing.T) {
	home := t.TempDir()
	actions, _ := windowsMountSeams(t, true)

	first := windowsMountOnce(t, home, testStorage())
	if len(*actions) != 2 {
		t.Fatalf("the first mount took %v, want the task create and the task run", *actions)
	}
	if !strings.Contains(first, "Mounted at Z:") {
		t.Fatalf("first mount printed %q, want the mounted line", first)
	}
	taskXMLPath := filepath.Join(DefaultConfigDir(home), "login-task.xml")
	if _, err := os.Stat(taskXMLPath); err != nil {
		t.Fatalf("the login task XML was not written: %v", err)
	}

	second := windowsMountOnce(t, home, testStorage())
	if len(*actions) != 2 {
		t.Fatalf("an unchanged re-run took %v, want no task action: a restart unmounts the drive letter under open files", *actions)
	}
	if !strings.Contains(second, "already running") {
		t.Fatalf("re-run printed %q, want it to say the mount is already running", second)
	}
}

func TestWindowsMountStartsAStoppedDriveWithUnchangedFiles(t *testing.T) {
	home := t.TempDir()
	actions, mounted := windowsMountSeams(t, true)

	windowsMountOnce(t, home, testStorage())
	*mounted = false
	windowsMountOnce(t, home, testStorage())
	if len(*actions) != 4 {
		t.Fatalf("a stopped drive with unchanged files took %v, want the task create and run twice", *actions)
	}
}

func TestWindowsMountRestartsWhenThePlanChanged(t *testing.T) {
	home := t.TempDir()
	actions, _ := windowsMountSeams(t, true)

	windowsMountOnce(t, home, testStorage())
	rotated := testStorage()
	rotated.SecretKey = "rotatedsecretkey"
	windowsMountOnce(t, home, rotated)
	if len(*actions) != 4 {
		t.Fatalf("a changed plan took %v, want the task create and run twice: a changed plan must still restart", *actions)
	}
	envBody, err := os.ReadFile(RcloneEnvPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(envBody), rotated.SecretKey) {
		t.Fatalf("rclone.env does not carry the rotated secret after the restart:\n%s", envBody)
	}
	taskXMLPath := filepath.Join(DefaultConfigDir(home), "login-task.xml")
	body, err := os.ReadFile(taskXMLPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), rotated.SecretKey) {
		t.Fatalf("the task XML carries the rotated secret:\n%s", body)
	}
}

func TestWindowsMountFailsWhenTheProbeCannotAnswer(t *testing.T) {
	home := t.TempDir()
	actions, _ := windowsMountSeams(t, true)
	windowsMountOnce(t, home, testStorage())

	probeErr := errors.New("WinFsp volume is wedged")
	origState := mountState
	mountState = func(string, string) (bool, error) { return false, probeErr }
	t.Cleanup(func() { mountState = origState })

	t.Setenv("USERDOMAIN", "DRIVE")
	t.Setenv("USERNAME", "test")
	err := Mount("windows", home, "rclone.exe", testStorage(), false, false, "Z:")
	if err == nil {
		t.Fatal("Mount returned nil, want a mount-probe failure when the probe errors")
	}
	if !strings.Contains(err.Error(), "Could not check whether the drive is mounted") || !strings.Contains(err.Error(), probeErr.Error()) {
		t.Fatalf("Mount error = %v, want the mount-probe sentence naming the probe's cause", err)
	}
	if len(*actions) != 2 {
		t.Fatalf("a probe that cannot answer took %v, want no task action: a restart unmounts the drive letter under open files", *actions)
	}
}

func TestWindowsUnchangedCheckIgnoresTheFileMode(t *testing.T) {
	home := t.TempDir()
	actions, _ := windowsMountSeams(t, true)

	windowsMountOnce(t, home, testStorage())
	for _, path := range []string{
		RcloneConfigPath(home),
		filepath.Join(DefaultConfigDir(home), "login-task.xml"),
	} {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	before := len(*actions)
	second := windowsMountOnce(t, home, testStorage())
	if len(*actions) != before {
		t.Fatalf("a re-run whose only difference is the file mode took %v, want no task action on Windows", *actions)
	}
	if !strings.Contains(second, "already running") {
		t.Fatalf("re-run printed %q, want it to say the mount is already running", second)
	}
	taskXML, err := os.ReadFile(filepath.Join(DefaultConfigDir(home), "login-task.xml"))
	if err != nil {
		t.Fatal(err)
	}
	writes := []mountWrite{
		{RcloneConfigPath(home), []byte(RcloneConfig(testStorage())), 0o600},
		{filepath.Join(DefaultConfigDir(home), "login-task.xml"), taskXML, 0o600},
	}
	if !mountWritesUnchanged("windows", writes) {
		t.Error("mountWritesUnchanged(windows) = false, want true: a mode means nothing on Windows")
	}
	if mountWritesUnchanged("linux", writes) {
		t.Error("mountWritesUnchanged(linux) = true, want false: a drifted mode is a change off Windows")
	}
	if mountWritesUnchanged("darwin", writes) {
		t.Error("mountWritesUnchanged(darwin) = true, want false: a drifted mode is a change off Windows")
	}
}
