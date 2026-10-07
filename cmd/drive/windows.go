package main

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

// Windows support (drive#153). Windows mounts the same stock `rclone mount`
// as Linux, but the mount point is a drive letter and the driver is WinFsp;
// the login item is a Task Scheduler task created with the stock schtasks
// tool. Nothing here is a helper script: every command is an OS tool called
// with an argument vector.
//
// The platform decisions are pure or injected functions — the drive letter,
// the schtasks argument vectors, the task's command line, the WinFsp check —
// so the unit tests drive every branch with an injected platform, the way the
// Mac and Linux tests drive BuildMountPlan with a goos string.

// WindowsTaskName is the Task Scheduler task that starts the mount at logon,
// the Windows counterpart of the launchd label and the systemd user unit.
const WindowsTaskName = "drive-mount"

const windowsDefaultLetter = "D:"

// winFspReinstall is what `drive mount` prints when WinFsp is missing. WinFsp
// is the driver that turns an rclone mount into a Windows drive letter; the
// Drive installer (drive#154) brings it in, so the fix is to reinstall Drive.
// The driver is never installed silently, and a hand-installed driver is not
// the product's instruction to give.
// winFspReinstall is what `drive mount` prints when WinFsp is missing. The
// sentence keeps its semicolon: the no-semicolon rule is for replies and PR
// text a person reads in a review, not for a failure string a user reads at a
// terminal, where one sentence with a semicolon is the clearer instruction.
const winFspReinstall = "WinFsp is not installed, so Windows cannot mount a drive letter; reinstall Drive, which installs WinFsp for you"

// winFspDLLs are the driver files WinFsp's own installer writes. The official
// installer puts them in <ProgramFiles(x86)>\WinFsp\bin and adds that
// directory to the system PATH, which is where rclone's cgofuse loads them
// from. More than one architecture is listed because a Windows machine can run
// either one.
func winFspDLLs() []string {
	root := os.Getenv("ProgramFiles(x86)")
	if root == "" {
		root = os.Getenv("ProgramW6432")
	}
	if root == "" {
		root = `C:\Program Files (x86)`
	}
	bin := filepath.Join(root, "WinFsp", "bin")
	return []string{
		filepath.Join(bin, "winfsp-x64.dll"),
		filepath.Join(bin, "winfsp-a64.dll"),
		filepath.Join(bin, "winfsp-x86.dll"),
	}
}

// CheckWinFsp returns the reinstall-Drive sentence when goos is Windows and
// none of WinFsp's driver files is present, and nil on every other platform.
// exists is the file probe, injected so a test can answer without a Windows
// machine.
func CheckWinFsp(goos string, exists func(string) bool) error {
	if goos != "windows" {
		return nil
	}
	for _, dll := range winFspDLLs() {
		if exists(dll) {
			return nil
		}
	}
	return errors.New(winFspReinstall)
}

// WindowsDriveLetter resolves the drive letter a Windows mount uses. An
// override is a letter, with or without a colon; it wins unless a volume
// already holds it, which is a named refusal rather than a mount that fails
// later. With no override the first free letter from D: up is chosen, as the
// issue asks. free reports whether a letter is free, injected so the test does
// not need a Windows machine's drives.
func WindowsDriveLetter(override string, free func(string) bool) (string, error) {
	if override != "" {
		letter, err := normalizeDriveLetter(override)
		if err != nil {
			return "", err
		}
		if !free(letter) {
			return "", fmt.Errorf("drive letter %s is already in use", letter)
		}
		return letter, nil
	}
	for c := byte('D'); c <= 'Z'; c++ {
		letter := string(c) + ":"
		if free(letter) {
			return letter, nil
		}
	}
	return "", errors.New("no free drive letter: D: to Z: are all taken")
}

// normalizeDriveLetter turns "z", "Z" or "z:" into "Z:" and refuses anything
// that is not one letter.
func normalizeDriveLetter(s string) (string, error) {
	letter := strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(s), ":"))
	if len(letter) != 1 || letter[0] < 'A' || letter[0] > 'Z' {
		return "", fmt.Errorf("%q is not a drive letter (A: to Z: only)", s)
	}
	return letter + ":", nil
}

// driveLetterFree reports whether a drive letter is free. os.Stat on the
// volume root is the platform's own answer (a letter with no volume errors)
// and needs no second tool.
func driveLetterFree(letter string) bool {
	_, err := os.Stat(windowsVolumeRoot(letter))
	return err != nil
}

// windowsVolumeMounted reports whether the drive letter answers, which is what
// a mount is: rclone attaches the remote at the letter and a stat on its root
// then succeeds.
//
// The path handed to Stat is the volume root (`D:\`), never the bare `D:`:
// `os.Stat("D:")` is a drive-relative path that resolves against the
// process's current directory on that drive and succeeds for any volume that
// exists, mounted or not, which would make every answer here a true answer. The
// trailing separator is what makes it the root.
func windowsVolumeMounted(letter string) bool {
	_, err := os.Stat(windowsVolumeRoot(letter))
	return err == nil
}

// windowsRcloneMountLetters is the set of letters that an rclone process on
// this machine mounts at, as reported by the running rclone processes. This is
// the only identification of "a Drive mount" that the platform itself offers:
// an every-volume stat cannot tell a WinFsp volume that Drive attached from a
// USB stick, an optical drive or another FUSE/FAT volume that happened to land
// on a letter between D: and Z:, and `tasklist`'s command line is where rclone
// carries the mount point it was started with.
//
// The letters come from the same rclone command lines the login task's command
// line is read from (windowsDriveLetterFromCommand), so both ends of the stop
// path answer the same question: which letters is rclone holding?
//
// Returns an error rather than an empty list when the process list cannot be
// read: an empty answer would report a stale mount as stopped, which is the
// failure this whole function exists to prevent.
func windowsRcloneMountLetters() ([]string, error) {
	out, err := exec.Command("tasklist", "/fo", "csv", "/nh").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("tasklist: %w: %s", err, strings.TrimSpace(string(out)))
	}
	// A CSV field whose value contains a comma is quoted with its commas
	// doubled ("Image Name","PID","...,"..."), which Go's encoding/csv cannot be
	// told about, so the command line is matched inside each record with the
	// existing letter reader instead of a CSV parse that would split on them.
	var letters []string
	for _, line := range strings.Split(string(out), "\n") {
		if letter, ok := windowsDriveLetterFromCommand(line); ok {
			letters = append(letters, letter)
		}
	}
	return letters, nil
}

// windowsVolumeRoot is the stat-able root of a drive letter: "Z:" becomes
// `Z:\`.
func windowsVolumeRoot(letter string) string {
	if strings.HasSuffix(letter, ":") {
		return letter + `\`
	}
	return letter
}

// WindowsTaskCommandLine is the login task's command as one command-line
// string: the same rclone argument vector the launchd plist and the systemd
// unit carry, quoted the way CreateProcess splits it. The task itself stores
// the plan as an Exec action's Command and Arguments (the XML, drive#368),
// and `schtasks /Query` renders that pair back as one command line, so this
// is the display form and the string the letter-finding reads.
func WindowsTaskCommandLine(p MountPlan) string {
	parts := append([]string{p.RcloneBin}, windowsMountArgs(p)...)
	for i, a := range parts {
		parts[i] = windowsQuoteArg(a)
	}
	return strings.Join(parts, " ")
}

// windowsQuoteArg quotes one argument per the Windows command-line rules
// (CommandLineToArgvW): an argument with whitespace or a quote is wrapped in
// quotes, a run of backslashes before a quote is doubled, and the quote itself
// is escaped.
func windowsQuoteArg(arg string) string {
	if arg != "" && !strings.ContainsAny(arg, " \t\n\v\"") {
		return arg
	}
	var b strings.Builder
	b.WriteByte('"')
	backslashes := 0
	for _, r := range arg {
		switch r {
		case '\\':
			backslashes++
			b.WriteRune(r)
		case '"':
			b.WriteString(strings.Repeat(`\`, backslashes+1))
			b.WriteRune(r)
			backslashes = 0
		default:
			backslashes = 0
			b.WriteRune(r)
		}
	}
	b.WriteString(strings.Repeat(`\`, backslashes))
	b.WriteByte('"')
	return b.String()
}

// The login task's Task Scheduler XML and its argument vector (drive#368).
// The /TR flag `schtasks /Create` takes for the task to run holds 261
// characters, and the task's command line is longer than that, so the create
// goes through the task XML instead — the stock way to register a task whose
// command outgrew /TR. The XML below is the subset of the Task Scheduler 2.0
// schema (the format `schtasks /Create /XML` reads) this task sets, with the
// fields in the schema's own order, which the import validates.

type taskRegInfoXML struct {
	Description string `xml:"Description"`
}

type taskLogonTriggerXML struct {
	Enabled bool   `xml:"Enabled"`
	UserId  string `xml:"UserId"`
}

type taskTriggersXML struct {
	LogonTrigger taskLogonTriggerXML `xml:"LogonTrigger"`
}

type taskPrincipalXML struct {
	ID        string `xml:"id,attr"`
	UserId    string `xml:"UserId"`
	LogonType string `xml:"LogonType"`
}

type taskPrincipalsXML struct {
	Principal taskPrincipalXML `xml:"Principal"`
}

type taskIdleSettingsXML struct {
	StopOnIdleEnd bool `xml:"StopOnIdleEnd"`
	RestartOnIdle bool `xml:"RestartOnIdle"`
}

type taskSettingsXML struct {
	MultipleInstancesPolicy    string              `xml:"MultipleInstancesPolicy"`
	DisallowStartIfOnBatteries bool                `xml:"DisallowStartIfOnBatteries"`
	StopIfGoingOnBatteries     bool                `xml:"StopIfGoingOnBatteries"`
	AllowHardTerminate         bool                `xml:"AllowHardTerminate"`
	StartWhenAvailable         bool                `xml:"StartWhenAvailable"`
	RunOnlyIfNetworkAvailable  bool                `xml:"RunOnlyIfNetworkAvailable"`
	IdleSettings               taskIdleSettingsXML `xml:"IdleSettings"`
	AllowStartOnDemand         bool                `xml:"AllowStartOnDemand"`
	Enabled                    bool                `xml:"Enabled"`
	Hidden                     bool                `xml:"Hidden"`
	RunOnlyIfIdle              bool                `xml:"RunOnlyIfIdle"`
	WakeToRun                  bool                `xml:"WakeToRun"`
	ExecutionTimeLimit         string              `xml:"ExecutionTimeLimit"`
	Priority                   int                 `xml:"Priority"`
}

type taskExecXML struct {
	Command   string `xml:"Command"`
	Arguments string `xml:"Arguments"`
}

type taskActionsXML struct {
	Context string      `xml:"Context,attr"`
	Exec    taskExecXML `xml:"Exec"`
}

type taskXML struct {
	XMLName          xml.Name          `xml:"Task"`
	Version          string            `xml:"version,attr"`
	XMLNS            string            `xml:"xmlns,attr"`
	RegistrationInfo taskRegInfoXML    `xml:"RegistrationInfo"`
	Triggers         taskTriggersXML   `xml:"Triggers"`
	Principals       taskPrincipalsXML `xml:"Principals"`
	Settings         taskSettingsXML   `xml:"Settings"`
	Actions          taskActionsXML    `xml:"Actions"`
}

// windowsTaskXMLPath is where the login task's XML lives: beside the rclone
// config, in the config directory the product already owns. schtasks reads
// the file once at /Create; keeping it makes a changed plan's overwrite (with
// /F) debuggable, and it is one of the two files the next run compares against
// the plan it would write (issue #561).
func windowsTaskXMLPath(p MountPlan) string {
	return filepath.Join(filepath.Dir(p.ConfigPath), "login-task.xml")
}

// windowsTaskXML is the login task as Task Scheduler XML. The Exec action
// carries the plan split the way Task Scheduler stores it: Command is the
// rclone path, Arguments is the same quoted argument vector the /TR string
// used to carry, so `schtasks /Query`'s "Task To Run" still reads as one
// command line and every reader of it (the drive letter, the stop path) is
// unchanged. userName is the login user the trigger fires for, in the
// DOMAIN\user form Task Scheduler requires.
func windowsTaskXML(p MountPlan, userName string) (string, error) {
	quoted := make([]string, 0, len(p.Args())+2)
	for _, a := range windowsMountArgs(p) {
		quoted = append(quoted, windowsQuoteArg(a))
	}
	doc := taskXML{
		Version: "1.2",
		XMLNS:   "http://schemas.microsoft.com/windows/2004/02/mit/task",
		RegistrationInfo: taskRegInfoXML{
			Description: "Mounts the Drive at logon (created by drive).",
		},
		Triggers: taskTriggersXML{
			// The trigger /SC ONLOGON used to set: start at this user's logon.
			LogonTrigger: taskLogonTriggerXML{Enabled: true, UserId: userName},
		},
		Principals: taskPrincipalsXML{
			// UserId is the account the task runs as, and it must be
			// the same account the LogonTrigger fires for: Task
			// Scheduler refuses an XML whose principal names no
			// account, and InteractiveToken runs the mount in that
			// user's logged-on session.
			// InteractiveToken is how /SC ONLOGON ran: in the logged-on
			// session, so the mount is visible on the user's desktop.
			Principal: taskPrincipalXML{ID: "Author", UserId: userName, LogonType: "InteractiveToken"},
		},
		Settings: taskSettingsXML{
			// One mount per logon: a repeated start never stacks a second
			// rclone on the same letter.
			MultipleInstancesPolicy: "IgnoreNew",
			// A laptop on battery still gets its drive at logon, and a mount
			// is not ended because the machine switched to battery.
			DisallowStartIfOnBatteries: false,
			StopIfGoingOnBatteries:     false,
			AllowHardTerminate:         true,
			StartWhenAvailable:         false,
			RunOnlyIfNetworkAvailable:  false,
			IdleSettings:               taskIdleSettingsXML{StopOnIdleEnd: false, RestartOnIdle: false},
			AllowStartOnDemand:         true,
			Enabled:                    true,
			Hidden:                     false,
			RunOnlyIfIdle:              false,
			WakeToRun:                  false,
			// PT0S is no time limit: the mount runs until `drive unmount`,
			// not until the scheduler's 72-hour default ends it.
			ExecutionTimeLimit: "PT0S",
			Priority:           7,
		},
		Actions: taskActionsXML{
			Context: "Author",
			Exec: taskExecXML{
				Command:   p.RcloneBin,
				Arguments: strings.Join(quoted, " "),
			},
		},
	}
	var b bytes.Buffer
	b.WriteString(xml.Header)
	enc := xml.NewEncoder(&b)
	enc.Indent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return "", fmt.Errorf("build the login task XML: %w", err)
	}
	if err := enc.Flush(); err != nil {
		return "", fmt.Errorf("build the login task XML: %w", err)
	}
	return b.String(), nil
}

// schtasksCreateXMLArgs is `schtasks /Create` from the task XML. /F
// overwrites an existing task, so `drive mount` is safe to run again. The XML
// carries the logon trigger in place of the /SC ONLOGON flag and the command
// in place of /TR, whose 261-character limit the task's command line
// outgrew (drive#368).
func schtasksCreateXMLArgs(taskName, xmlPath string) []string {
	return []string{"/Create", "/F", "/TN", taskName, "/XML", xmlPath}
}

// windowsTaskUser is the user the login task starts for, in the DOMAIN\user
// form the task XML's UserId requires. USERDOMAIN and USERNAME are exported
// by every Windows session; os/user resolves the same account from the
// process token when they are missing. On Entra ID (Azure AD) joined
// machines the names can take the tenant's own form (AzureAD\user@tenant);
// if Task Scheduler refuses that name at /Create, mount fails with the
// schtasks output naming it, which is the machine's own answer to debug.
func windowsTaskUser() (string, error) {
	domain, name := os.Getenv("USERDOMAIN"), os.Getenv("USERNAME")
	if domain != "" && name != "" {
		return domain + `\` + name, nil
	}
	u, err := user.Current()
	if err != nil {
		return "", fmt.Errorf("resolve the user the login task runs as: %w", err)
	}
	return u.Username, nil
}

// windowsSchtasksQuoted is one schtasks command line a reader can paste at a
// prompt: every argument is quoted the way CreateProcess splits it, so a path
// that holds a space (C:\Users\Jane Doe\...\login-task.xml) survives the
// copy instead of reaching schtasks as three arguments.
func windowsSchtasksQuoted(args ...string) string {
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, windowsQuoteArg(a))
	}
	return "schtasks " + strings.Join(quoted, " ")
}

func schtasksRunArgs(taskName string) []string    { return []string{"/Run", "/TN", taskName} }
func schtasksEndArgs(taskName string) []string    { return []string{"/End", "/TN", taskName} }
func schtasksDeleteArgs(taskName string) []string { return []string{"/Delete", "/F", "/TN", taskName} }
func schtasksQueryArgs(taskName string) []string  { return []string{"/Query", "/TN", taskName} }
func schtasksVerboseArgs(taskName string) []string {
	return []string{"/Query", "/TN", taskName, "/FO", "LIST", "/V"}
}

// windowsTaskToRun reads the "Task To Run" value out of `schtasks /Query /TN
// <name> /FO LIST /V`. That value is the command line the task starts, which
// is where the chosen drive letter is. The heading is matched without regard
// to case; the value keeps its own case.
func windowsTaskToRun(listOutput string) (string, bool) {
	for _, line := range strings.Split(listOutput, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(key), "Task To Run") {
			return strings.TrimSpace(value), true
		}
	}
	return "", false
}

// windowsDriveLetterFromCommand finds the mount point in a task's command
// line: the token that is one letter and a colon. The remote is
// drive:<bucket>/<prefix>, every other argument is a flag or a path, and a
// quoted path's first token is longer than two characters, so the drive letter
// is the only bare letter-colon token.
func windowsDriveLetterFromCommand(command string) (string, bool) {
	for _, tok := range strings.Fields(command) {
		tok = strings.Trim(tok, `"`)
		if len(tok) != 2 || tok[1] != ':' {
			continue
		}
		c := tok[0]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') {
			return strings.ToUpper(tok), true
		}
	}
	return "", false
}

// windowsTaskPresent answers whether the login task exists. A non-zero
// schtasks exit is the not-found answer, not a command failure; a schtasks
// that could not even run is returned as an error.
func windowsTaskPresent(taskName string) (bool, error) {
	out, err := exec.Command("schtasks", schtasksQueryArgs(taskName)...).CombinedOutput()
	if err == nil {
		return true, nil
	}
	if _, ok := err.(*exec.ExitError); ok {
		return false, nil
	}
	return false, fmt.Errorf("schtasks query %s: %w: %s", taskName, err, strings.TrimSpace(string(out)))
}

// windowsTaskCommand is the command line the login task runs, when the task
// exists.
func windowsTaskCommand(taskName string) (string, bool, error) {
	out, err := exec.Command("schtasks", schtasksVerboseArgs(taskName)...).CombinedOutput()
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return "", false, nil
		}
		return "", false, fmt.Errorf("schtasks query %s: %w: %s", taskName, err, strings.TrimSpace(string(out)))
	}
	command, ok := windowsTaskToRun(string(out))
	return command, ok, nil
}

// windowsMountLetter is the drive letter the mount uses or used: the task's own
// command line when the task exists, and the first free letter otherwise, which
// is what a new mount would choose.
func windowsMountLetter() (string, error) {
	if command, ok, err := windowsTaskCommand(WindowsTaskName); err != nil {
		return "", err
	} else if ok {
		if letter, found := windowsDriveLetterFromCommand(command); found {
			return letter, nil
		}
	}
	return WindowsDriveLetter("", driveLetterFree)
}

// runSchtasks runs one stock schtasks verb and turns a non-zero exit into an
// error carrying the tool's own output. A var so a test can record the
// actions a mount takes instead of touching a machine's Task Scheduler,
// the way startLoginItem records the login-item start (drive#817).
var runSchtasks = func(args ...string) error {
	out, err := exec.Command("schtasks", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// winFspCheck is the WinFsp driver check a Windows mount makes first. The
// driver files exist only on a Windows machine, so the check is a var a test
// answers on any runner the way CheckWinFsp is injected with its file probe
// (drive#817).
var winFspCheck = CheckWinFsp

// mountWindows is the Windows half of `drive mount`: check the driver, write
// the rclone config, register the logon task with schtasks and start it, then
// wait for the kernel to report the drive letter. A foreground mount runs
// rclone in this process instead, which is what the mount proof and debugging
// use. A re-run whose config and task XML are already on disk says the mount is
// already running and leaves it alone (issue #561), because recreating the
// task with /F and running it again would unmount a live drive letter under
// open files. The same unchanged check skips the permission bits on Windows,
// where a file's mode carries no meaning (drive#817).
func windowsMountArgs(p MountPlan) []string {
	args := p.Args()
	// The task XML is mode 0600 (windows.go WriteFileAtomic). Task Scheduler
	// has no EnvironmentFile, so the storage secret is rclone's own
	// --s3-secret-access-key on that 0600 file rather than an Environment=
	// line in a world-readable unit (drive#498).
	if p.SecretKey != "" {
		args = append(args, "--s3-secret-access-key", p.SecretKey)
	}
	return args
}

func mountWindows(p MountPlan, home string, c StorageConfig, foreground, dryRun bool) error {
	if err := winFspCheck(p.GOOS, fileExists); err != nil {
		return err
	}
	taskXMLPath := windowsTaskXMLPath(p)
	if dryRun {
		p.RCUser, p.RCPass = "<redacted>", "<redacted>"
		commandLine := WindowsTaskCommandLine(p)
		userName, err := windowsTaskUser()
		if err != nil {
			return err
		}
		taskXMLBody, err := windowsTaskXML(p, userName)
		if err != nil {
			return err
		}
		fmt.Printf("--- %s ---\n%s", p.ConfigPath, RcloneConfigRedacted(c))
		fmt.Printf("--- %s ---\n%s", RcloneEnvPath(home), rcloneEnvRedacted(p))
		fmt.Printf("--- Task Scheduler task %s (XML: %s) ---\n%s\n", WindowsTaskName, taskXMLPath, commandLine)
		fmt.Printf("--- task XML ---\n%s\n", taskXMLBody)
		fmt.Printf("--- would run ---\n%s\n", windowsSchtasksQuoted(schtasksCreateXMLArgs(WindowsTaskName, taskXMLPath)...))
		return nil
	}
	envBefore, envBeforeErr := os.ReadFile(RcloneEnvPath(home))
	if err := prepareMountAuth(home, &p, c); err != nil {
		return err
	}
	// The cache holds transient bytes by design (issue #561): mark it so a
	// backup tool that walks the profile skips it, on every platform.
	if err := writeCacheTag(p.CacheDir); err != nil {
		return err
	}
	envAfter, envAfterErr := os.ReadFile(RcloneEnvPath(home))
	envChanged := envBeforeErr != nil || envAfterErr != nil || !bytes.Equal(envBefore, envAfter)
	configBody := []byte(RcloneConfig(c))
	if foreground {
		if err := WriteFileAtomic(p.ConfigPath, configBody, 0o600); err != nil {
			return err
		}
		return mountForeground(p, home)
	}
	userName, err := windowsTaskUser()
	if err != nil {
		return err
	}
	taskXMLBody, err := windowsTaskXML(p, userName)
	if err != nil {
		return err
	}
	// A re-run that would write exactly what is already on disk must not
	// recreate and restart the login task (issue #561), because schtasks /F
	// with /Run stops the running rclone and unmounts a live drive letter under
	// open files. The two files this path writes are the rclone config and the
	// task XML, and both hold the whole plan: the XML carries the command line
	// the task starts, so a changed secret, a changed rc pair and a changed
	// drive letter all show up in its bytes. When nothing changed and the
	// letter is up, the run says so and leaves the mount alone. A stopped drive
	// still starts: unchanged files are not a reason to leave a mount down.
	writes := []mountWrite{
		{p.ConfigPath, configBody, 0o600},
		{taskXMLPath, []byte(taskXMLBody), 0o600},
	}
	if !envChanged && mountWritesUnchanged(p.GOOS, writes) {
		up, probeErr := mountState(p.GOOS, home)
		if probeErr != nil {
			// A probe that cannot answer is not an answer, and the drive is
			// only called up once the kernel says so. A wedged WinFsp volume is
			// what makes the probe fail, and a restart would unmount a live
			// mount under open files, so the run neither restarts nor reports
			// success: it fails and names the cause.
			return failDetail("mount-probe", probeErr, p.MountDir, probeErr.Error())
		}
		if up {
			fmt.Printf("Mount already running at %s\n", p.MountDir)
			return nil
		}
	}
	for _, w := range writes {
		if err := WriteFileAtomic(w.path, w.data, w.mode); err != nil {
			return err
		}
	}
	// Registering the task is the enable half, running it is the start half,
	// the same two steps the Linux path takes with systemctl. The task is
	// registered from its XML, because its command line is over the 261
	// characters the /TR flag holds (drive#368).
	if err := runSchtasks(schtasksCreateXMLArgs(WindowsTaskName, taskXMLPath)...); err != nil {
		return fmt.Errorf("create the login task: %w", err)
	}
	if err := runSchtasks(schtasksRunArgs(WindowsTaskName)...); err != nil {
		return fmt.Errorf("start the login task: %w", err)
	}
	if err := waitMounted("windows", home); err != nil {
		return err
	}
	printMountedLine(p.MountDir)
	return nil
}

// unmountWindows stops the running rclone through its task, waits for the
// drive letter to disappear, then removes the task so it cannot start the
// mount at the next logon. The order is the issue's: stop the mount cleanly,
// then remove the login task.
func unmountWindows(home string) error {
	present, err := windowsTaskPresent(WindowsTaskName)
	if err != nil {
		return err
	}
	if !present {
		return nil
	}
	command, _, _ := windowsTaskCommand(WindowsTaskName)
	letter, _ := windowsDriveLetterFromCommand(command)
	if err := runSchtasks(schtasksEndArgs(WindowsTaskName)...); err != nil {
		// The task exists but is not running; the delete below is still what
		// removes the login item, so this is a note and not a failure.
		fmt.Fprintf(os.Stderr, "note: could not stop the login task (%v); it is removed below\n", err)
	}
	if letter != "" {
		if err := waitWindowsVolumeGone(letter); err != nil {
			return err
		}
	}
	if err := runSchtasks(schtasksDeleteArgs(WindowsTaskName)...); err != nil {
		return fmt.Errorf("remove the login task: %w", err)
	}
	return nil
}

// waitWindowsVolumeGone polls the drive letter until WinFsp has detached it,
// so `drive unmount` reports the mount down only once the kernel agrees. A
// letter that never disappears is a named failure, like the Linux wait.
func waitWindowsVolumeGone(letter string) error {
	deadline := time.Now().Add(mountWait)
	for time.Now().Before(deadline) {
		if !windowsVolumeMounted(letter) {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("drive letter %s is still mounted after %s", letter, mountWait)
}

// stopWindowsMount is the Windows half of stopMount: end the task's process,
// then prove the drive letter is gone. Unmount normally already did both; this
// is the measured end state logout and uninstall rely on.
//
// Three things are measured rather than assumed, because the login task, the
// rclone process and the drive letter are three separate things:
//
//   - schtasks /End is asynchronous, so a letter that is still mounted one
//     instant after /End is not a failure. The poll waits for WinFsp to detach
//     it and fails only when the wait runs out.
//   - A mount whose task is already gone is still held by an rclone process, so
//     the running rclone processes are asked which letters they mount at
//     (windowsRcloneMountLetters). Asking WindowsDriveLetter for a letter
//     instead would name one that is FREE, which is the letter nothing is
//     mounted at, and would report a stale mount as stopped.
//   - A /End that could not be run at all (a permission failure) is the reason a
//     letter stays mounted, so it is carried into the failure below instead of
//     being printed and forgotten.
func stopWindowsMount(home string) error {
	// Every letter rclone is holding right now, read before the stop attempt
	// and after it, so a mount that outlives /End is caught either way.
	endErr := error(nil)
	if present, err := windowsTaskPresent(WindowsTaskName); err == nil && present {
		if err := runSchtasks(schtasksEndArgs(WindowsTaskName)...); err != nil {
			// The task exists but is not running, or could not be ended. The
			// volume check below is what decides whether anything is left, and
			// the reason is carried there so the failure can name it.
			endErr = err
		}
	}
	// With no task to end, the rclone processes are what hold the mount. The
	// task's own command line is a second, cheaper source when it is there, so
	// it is read first and the process list is the fallback that also covers a
	// task-less stale mount.
	letters := map[string]bool{}
	if command, ok, _ := windowsTaskCommand(WindowsTaskName); ok {
		if letter, found := windowsDriveLetterFromCommand(command); found {
			letters[letter] = true
		}
	}
	held, err := windowsRcloneMountLetters()
	if err != nil {
		// The process list could not be read, so a stale rclone mount cannot be
		// ruled out and the stop is not proved.
		return fmt.Errorf("could not check the running rclone mounts: %w", err)
	}
	for _, l := range held {
		letters[l] = true
	}
	for l := range letters {
		if err := waitWindowsVolumeGone(l); err != nil {
			if endErr != nil {
				return fmt.Errorf("%w (ending the login task also failed: %v)", err, endErr)
			}
			return err
		}
	}
	return nil
}

// fileExists is the real file probe the WinFsp check uses.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
