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
	// /Create must overwrite, so `drive mount` is safe to run again. The
	// logon trigger and the command travel in the task XML (drive#368): /TR
	// holds 261 characters and the task's command line is longer than that.
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
	p := BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage())
	p.MountDir = "Z:"
	body, err := windowsTaskXML(p, `DESKTOP\test`)
	if err != nil {
		t.Fatal(err)
	}
	var doc taskXML
	if err := xml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatalf("the task XML does not parse: %v\n%s", err, body)
	}
	// The envelope schtasks validates on import: a declaration, the Task
	// Scheduler 2.0 namespace and a version it knows.
	if !strings.HasPrefix(body, xml.Header) {
		t.Errorf("the task XML must start with the declaration, got:\n%.40s", body)
	}
	if doc.XMLNS != "http://schemas.microsoft.com/windows/2004/02/mit/task" {
		t.Errorf("task XMLNS = %q, want the Task Scheduler 2.0 namespace", doc.XMLNS)
	}
	if doc.Version != "1.2" {
		t.Errorf("task XML version = %q, want 1.2", doc.Version)
	}
	if doc.Actions.Exec.Command != `C:\rclone\rclone.exe` {
		t.Errorf("Exec Command = %q, want the rclone path", doc.Actions.Exec.Command)
	}
	for _, want := range []string{"mount", "drive:drive-standin/u/1234", "Z:", "--config", "rclone.conf", "--vfs-cache-mode full"} {
		if !strings.Contains(doc.Actions.Exec.Arguments, want) {
			t.Errorf("Exec Arguments missing %q:\n%s", want, doc.Actions.Exec.Arguments)
		}
	}
	// The logon trigger is what /SC ONLOGON set, scoped to the user who ran
	// `drive mount`, and the mount runs in the logged-on session.
	if !doc.Triggers.LogonTrigger.Enabled {
		t.Error("the logon trigger must be enabled: it is what /SC ONLOGON did")
	}
	if doc.Triggers.LogonTrigger.UserId != `DESKTOP\test` {
		t.Errorf("LogonTrigger UserId = %q, want the user who mounted", doc.Triggers.LogonTrigger.UserId)
	}
	if doc.Principals.Principal.LogonType != "InteractiveToken" {
		t.Errorf("LogonType = %q, want InteractiveToken: the mount runs in the logged-on session", doc.Principals.Principal.LogonType)
	}
	// The principal names the account the task runs as, and it is the same
	// account the logon trigger fires for. Task Scheduler refuses an XML whose
	// principal names no account, and a principal for a different account
	// would have the mount run as someone other than the person mounting.
	if doc.Principals.Principal.UserId != `DESKTOP\test` {
		t.Errorf("Principal UserId = %q, want the user who mounted", doc.Principals.Principal.UserId)
	}
	if doc.Triggers.LogonTrigger.UserId != doc.Principals.Principal.UserId {
		t.Errorf("the logon trigger fires for %q but the principal names %q: they must be one account",
			doc.Triggers.LogonTrigger.UserId, doc.Principals.Principal.UserId)
	}
	// The mount runs until `drive unmount`, not until the scheduler's
	// 72-hour default ends it.
	if doc.Settings.ExecutionTimeLimit != "PT0S" {
		t.Errorf("ExecutionTimeLimit = %q, want PT0S (no time limit): a mount killed by the default is a drive that vanishes after 3 days", doc.Settings.ExecutionTimeLimit)
	}
	// "Task To Run" is what `schtasks /Query` renders from Command and
	// Arguments, and it is where the stop path finds the drive letter.
	toRun := doc.Actions.Exec.Command + " " + doc.Actions.Exec.Arguments
	if letter, ok := windowsDriveLetterFromCommand(toRun); !ok || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want Z:", toRun, letter, ok)
	}
}

// TestWindowsTaskXMLStaysInsideSchtasksLimits is the drive#368 guard: every
// string the registration hands schtasks must fit the channel that carries
// it. The task-to-run string used to go through /TR, which holds 261
// characters, and the task's command line outgrew that — so the create goes
// through the XML now, and this test fails if anything drifts back over a
// limit: the /XML path argument and the Exec Command are path strings on the
// same 261-character rule, the Exec Arguments answer to the Task Scheduler
// API's 32 K ceiling, and a /TR in the create vector is the old failure back
// again.
func TestWindowsTaskXMLStaysInsideSchtasksLimits(t *testing.T) {
	p := BuildMountPlan("windows", `C:\Users\test`, `C:\rclone\rclone.exe`, testStorage())
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
	// The principal must name an account, and the name is a UserId string on
	// the same 261-character rule.
	if doc.Principals.Principal.UserId == "" {
		t.Error("the principal names no UserId: Task Scheduler refuses an XML whose principal has no account")
	}
	if len(doc.Principals.Principal.UserId) > 261 {
		t.Errorf("the principal UserId is %d characters, over the 261 the field holds: %s",
			len(doc.Principals.Principal.UserId), doc.Principals.Principal.UserId)
	}
}

// TestWindowsSchtasksQuotedKeepsASpacedPathWhole is the dry run's create line:
// `drive mount --dry-run` prints the schtasks command a person can paste, so
// an argument that holds a space has to be quoted, or the paste breaks on the
// first space and the task is never created.
func TestWindowsSchtasksQuotedKeepsASpacedPathWhole(t *testing.T) {
	// The path is written the way a Windows account spells it, spaces and all.
	xmlPath := `C:\Users\Jane Doe\.config\drive\login-task.xml`
	got := windowsSchtasksQuoted(schtasksCreateXMLArgs(WindowsTaskName, xmlPath)...)
	want := "schtasks /Create /F /TN " + WindowsTaskName + ` /XML "` + xmlPath + `"`
	if got != want {
		t.Errorf("windowsSchtasksQuoted() =\n%s\nwant\n%s", got, want)
	}
	// The plain path is printed as it is: quoting an argument with no space
	// would make the line harder to read, not safer.
	plain := windowsSchtasksQuoted(schtasksCreateXMLArgs(WindowsTaskName, `C:\drive\login-task.xml`)...)
	if strings.Contains(plain, `"`) {
		t.Errorf("a path with no space should not be quoted: %s", plain)
	}
}

// TestWindowsTaskXMLImportsIntoSchtasks is the drive#368 proof on Windows
// itself: a task whose command line is far over the 261 characters /TR held
// is registered through the stock `schtasks /Create /XML`, schtasks reads the
// XML back as the task it stored, and the "Task To Run" it renders still
// names the drive letter the stop path looks for. It runs on windows-latest,
// where schtasks is on PATH; every other platform skips with the reason. The
// end-to-end mount (TestWindowsMountProof) proves the task runs; this one is
// the command-length case, which that proof's own short command never
// reaches.
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
	home := t.TempDir()
	c := testStorage()
	c.Bucket = "bucket"
	c.Prefix = "u/" + strings.Repeat("deep-folder-name/", 12) + "1234"
	p := BuildMountPlan("windows", home, `C:\rclone\rclone.exe`, c)
	p.MountDir = "Z:"
	userName, err := windowsTaskUser()
	if err != nil {
		t.Fatal(err)
	}
	body, err := windowsTaskXML(p, userName)
	if err != nil {
		t.Fatal(err)
	}
	// The command line this would have handed /TR. The mount proof's own
	// command is long enough on its own, and this prefix makes it longer
	// still, so the case is not a near miss.
	commandLine := WindowsTaskCommandLine(p)
	if len(commandLine) <= 261 {
		t.Fatalf("the command line is %d characters, under the 261 this test must be over: %s", len(commandLine), commandLine)
	}
	xmlPath := windowsTaskXMLPath(p)
	if err := WriteFileAtomic(xmlPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	// Register the task the way `drive mount` does, then read it back with
	// the tool's own query.
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
	// The command schtasks renders from Command and Arguments is the same one
	// /TR used to carry, over the limit that broke it.
	if len(command) <= 261 {
		t.Errorf("Task To Run is %d characters, want the same command /TR could not hold: %s", len(command), command)
	}
	if letter, found := windowsDriveLetterFromCommand(command); !found || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want Z:", command, letter, found)
	}
	if !strings.Contains(command, p.RcloneBin) {
		t.Errorf("Task To Run is missing the rclone path:\n%s", command)
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
	// The Windows mount point is a drive letter, and a stat must hit the volume
	// root (`D:\\`), never the drive-relative `D:` — the latter resolves against
	// the process's per-drive current directory and would answer for any volume
	// that exists, not for a Drive mount specifically. The normalization now
	// lives in windowsVolumeMounted/Root, so MountedDir must answer identically
	// for every spelling of the same letter.
	for _, spell := range []string{"Z:", "Z:\\", "z:", "z:\\"} {
		got, err := MountedDir("windows", spell)
		if err != nil {
			t.Fatalf("MountedDir(windows, %q) error: %v", spell, err)
		}
		if got != windowsVolumeMounted("Z:") {
			t.Errorf("MountedDir(windows, %q) = %v, want %v (the volume-root normalization)", spell, got, windowsVolumeMounted("Z:"))
		}
	}
	// The normalization itself is the contract a bare letter cannot meet: only
	// the rooted spelling is the volume root, and the rooted spelling is what
	// both the mounted check and the status entry count are built on.
	if windowsVolumeRoot("Z:") != `Z:\` || windowsVolumeRoot("Z:\\") != `Z:\` {
		t.Errorf("windowsVolumeRoot must normalize to the bare root Z:\\")
	}
	if windowsVolumeRoot("Z:") == "Z:" {
		t.Error("windowsVolumeRoot must not return the drive-relative Z:, which is what this normalization exists to prevent")
	}
}

func TestWindowsRcloneMountLettersReadsTheProcessList(t *testing.T) {
	// tasklist rows are CSV, and a command line with a comma is a quoted field
	// with the comma doubled, so the record is matched by the existing letter
	// reader rather than a CSV split. The rows below are what a Windows runner
	// with a Drive mount, an unrelated volume and an unrelated process look
	// like, and only the rclone row's letter is ever reported.
	rows := strings.Join([]string{
		`"rclone.exe","4242","Console","1","25,000 K"`,
		`"rclone.exe","4242","Console","1","25,000 K"`,
	}, "\r\n")
	if letter, ok := windowsDriveLetterFromCommand(rows); ok {
		t.Errorf("windowsDriveLetterFromCommand on a process list must not find a letter, got %q", letter)
	}
	// The mount row carries the letter as its own token, exactly as the login
	// task's command line does.
	row := `"rclone.exe","4242","Console","1","25,000 K" mount drive:drive-standin/u/1 Z: --config C:\Users\t\.config\drive\rclone.conf`
	if letter, ok := windowsDriveLetterFromCommand(row); !ok || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want Z:, true", row, letter, ok)
	}
}

func TestWindowsRcloneMountLettersIsWindowsOnly(t *testing.T) {
	// The reader shells out to tasklist, so on any other platform it returns
	// the error it reports, not a wrong answer. The stop path propagates that
	// error rather than reporting a stale mount as stopped.
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

// TestWindowsTaskUserPrefersTheSessionDomain is the drive#368 user the login
// task's trigger names: USERDOMAIN and USERNAME are the session's own answer,
// and the process token is the fallback when they are missing. An empty answer
// would put a UserId the task XML cannot import.
func TestWindowsTaskUserPrefersTheSessionDomain(t *testing.T) {
	t.Setenv("USERDOMAIN", "DESKTOP")
	t.Setenv("USERNAME", "test")
	got, err := windowsTaskUser()
	if err != nil {
		t.Fatal(err)
	}
	// The DOMAIN\user form is what the task XML's UserId field requires.
	if got != `DESKTOP\test` {
		t.Errorf("windowsTaskUser() = %q, want DESKTOP\\test", got)
	}
	// With no session variables the answer comes from the process token; it
	// must still name a user, never come back empty.
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
		// The windows-latest job installs rclone in the step before this proof
		// runs, so a missing rclone here means that install broke. Skipping
		// would leave the job green with no drive-letter mount in it, so this
		// is a failure, not a skip.
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
	// Seed one object into the stand-in through stock rclone, so the read is
	// of an object and not a local file the mount happens to see.
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	seedStandin(t, root, cfg, append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(home), rcloneSecretEnv+"="+cfg.SecretKey), "seed.bin", 1<<20)

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

// The re-run fix on Windows (drive issue #817): a second `drive init` or
// `drive mount` whose files are already on disk must not recreate and restart
// the login task, because schtasks /F with /Run stops the running rclone and
// unmounts a live drive letter under open files. Every Windows-only seam is
// injected here — the WinFsp check, the schtasks verbs, the mounted probe and
// the wait probe — so the whole Windows path runs on a Linux runner the way
// BuildMountPlan runs with a goos string. The returned log is the schtasks
// verbs the run took, and the returned flag is what the probe answers about
// the drive letter, which a test can flip the way the Mac test flips its gate.
// The shape mirrors mountTestSeams.
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

// windowsMountOnce runs one `drive init`'s Mount call on the Windows path and
// returns what it printed. The plan's own storage config is the argument, so a
// caller can hand it a rotated secret.
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
	// The task XML is one of the files the unchanged check reads.
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
	// The drive letter is down (a reboot, a `drive unmount`): "unchanged" is
	// not a reason to leave a mount down, so this run still starts it.
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
	// A rotated storage key rewrites the config and the task's own command
	// line (the secret is rclone's --s3-secret-access-key, #498), so this run
	// is a real change: the login task is recreated and restarted.
	rotated := testStorage()
	rotated.SecretKey = "rotatedsecretkey"
	windowsMountOnce(t, home, rotated)
	if len(*actions) != 4 {
		t.Fatalf("a changed plan took %v, want the task create and run twice: a changed plan must still restart", *actions)
	}
	// The changed plan is what ends up on disk: the task XML carries the
	// rotated secret.
	taskXMLPath := filepath.Join(DefaultConfigDir(home), "login-task.xml")
	body, err := os.ReadFile(taskXMLPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), rotated.SecretKey) {
		t.Fatalf("the task XML does not carry the rotated secret after the restart:\n%s", body)
	}
}

// A probe that cannot answer is not an answer (drive#817): with the files
// unchanged but mountState failing — a wedged WinFsp volume is what makes the
// probe fail — the run must neither restart the login task (a restart unmounts
// a live drive letter under open files) nor report success. It fails and names
// the cause, the same shape as the Mac and Linux path (mount.go's mount-probe).
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

// A file mode carries no meaning on Windows: the file system stores only a
// read-only attribute and a stat answers with the mode every Unix write would
// use, so comparing Perm() there would call every unchanged re-run a change
// (drive#817). The bytes decide on Windows; everywhere else a drifted mode is
// still repaired.
func TestWindowsUnchangedCheckIgnoresTheFileMode(t *testing.T) {
	home := t.TempDir()
	actions, _ := windowsMountSeams(t, true)

	windowsMountOnce(t, home, testStorage())
	// The 0600 the Windows write asks for, drifted the way a Windows stat
	// reports it back.
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
	// The same drifted mode is a change on the platforms whose permission bits
	// mean something, so the fix is Windows-only and their mount still repairs
	// it.
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
