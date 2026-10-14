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

// WindowsTaskName is the Task Scheduler task that starts the mount at logon, the Windows counterpart of the launchd label and the systemd user unit.
const WindowsTaskName = "drive-mount"

const windowsDefaultLetter = "D:"

const winFspReinstall = "WinFsp is not installed, so Windows cannot mount a drive letter; reinstall Storagebun, which installs WinFsp for you"

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

// CheckWinFsp returns the reinstall-Storagebun sentence when goos is Windows and none of WinFsp's driver files is present, and nil on every other platform.
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

// WindowsDriveLetter resolves the drive letter a Windows mount uses.
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

func normalizeDriveLetter(s string) (string, error) {
	letter := strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(s), ":"))
	if len(letter) != 1 || letter[0] < 'A' || letter[0] > 'Z' {
		return "", fmt.Errorf("%q is not a drive letter (A: to Z: only)", s)
	}
	return letter + ":", nil
}

func driveLetterFree(letter string) bool {
	_, err := os.Stat(windowsVolumeRoot(letter))
	return err != nil
}

func windowsVolumeMounted(letter string) bool {
	_, err := os.Stat(windowsVolumeRoot(letter))
	return err == nil
}

func windowsRcloneMountLetters() ([]string, error) {
	out, err := exec.Command("tasklist", "/fo", "csv", "/nh").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("tasklist: %w: %s", err, strings.TrimSpace(string(out)))
	}
	var letters []string
	for _, line := range strings.Split(string(out), "\n") {
		if letter, ok := windowsDriveLetterFromCommand(line); ok {
			letters = append(letters, letter)
		}
	}
	return letters, nil
}

func windowsVolumeRoot(letter string) string {
	if strings.HasSuffix(letter, ":") {
		return letter + `\`
	}
	return letter
}

// WindowsTaskCommandLine is the login task's command as one command-line string: this CLI in the foreground, quoted the way CreateProcess splits it (drive#515).
func WindowsTaskCommandLine(p MountPlan) string {
	parts := p.productArgv()
	for i, a := range parts {
		parts[i] = windowsQuoteArg(a)
	}
	return strings.Join(parts, " ")
}

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
	Command          string `xml:"Command"`
	Arguments        string `xml:"Arguments"`
	WorkingDirectory string `xml:"WorkingDirectory"`
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

func windowsTaskXMLPath(p MountPlan) string {
	return filepath.Join(filepath.Dir(p.ConfigPath), "login-task.xml")
}

func windowsTaskXML(p MountPlan, userName string) (string, error) {
	argv := p.productArgv()
	if len(argv) == 0 {
		return "", fmt.Errorf("login task has no command")
	}
	quoted := make([]string, 0, len(argv)-1)
	for _, a := range argv[1:] {
		quoted = append(quoted, windowsQuoteArg(a))
	}
	doc := taskXML{
		Version: "1.2",
		XMLNS:   "http://schemas.microsoft.com/windows/2004/02/mit/task",
		RegistrationInfo: taskRegInfoXML{
			Description: "Mounts the Storagebun folder at logon (created by drive).",
		},
		Triggers: taskTriggersXML{
			LogonTrigger: taskLogonTriggerXML{Enabled: true, UserId: userName},
		},
		Principals: taskPrincipalsXML{
			Principal: taskPrincipalXML{ID: "Author", UserId: userName, LogonType: "InteractiveToken"},
		},
		Settings: taskSettingsXML{
			MultipleInstancesPolicy:    "IgnoreNew",
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
			ExecutionTimeLimit:         "PT0S",
			Priority:                   7,
		},
		Actions: taskActionsXML{
			Context: "Author",
			Exec: taskExecXML{
				Command:          argv[0],
				Arguments:        strings.Join(quoted, " "),
				WorkingDirectory: filepath.Dir(p.ConfigPath),
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

func schtasksCreateXMLArgs(taskName, xmlPath string) []string {
	return []string{"/Create", "/F", "/TN", taskName, "/XML", xmlPath}
}

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

var runSchtasks = func(args ...string) error {
	out, err := exec.Command("schtasks", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

var winFspCheck = CheckWinFsp

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
	writes := []mountWrite{
		{p.ConfigPath, configBody, 0o600},
		{taskXMLPath, []byte(taskXMLBody), 0o600},
	}
	if !envChanged && mountWritesUnchanged(p.GOOS, writes) {
		up, probeErr := mountState(p.GOOS, home)
		if probeErr != nil {
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

func stopWindowsMount(home string) error {
	endErr := error(nil)
	if present, err := windowsTaskPresent(WindowsTaskName); err == nil && present {
		if err := runSchtasks(schtasksEndArgs(WindowsTaskName)...); err != nil {
			endErr = err
		}
	}
	letters := map[string]bool{}
	if command, ok, _ := windowsTaskCommand(WindowsTaskName); ok {
		if letter, found := windowsDriveLetterFromCommand(command); found {
			letters[letter] = true
		}
	}
	held, err := windowsRcloneMountLetters()
	if err != nil {
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

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
