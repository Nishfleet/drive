package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
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
	return "", errors.New("no free drive letter between D: and Z:")
}

// normalizeDriveLetter turns "z", "Z" or "z:" into "Z:" and refuses anything
// that is not one letter.
func normalizeDriveLetter(s string) (string, error) {
	letter := strings.ToUpper(strings.TrimSuffix(strings.TrimSpace(s), ":"))
	if len(letter) != 1 || letter[0] < 'A' || letter[0] > 'Z' {
		return "", fmt.Errorf("%q is not a drive letter between A: and Z:", s)
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
func windowsVolumeMounted(letter string) bool {
	_, err := os.Stat(windowsVolumeRoot(letter))
	return err == nil
}

// windowsVolumeRoot is the stat-able root of a drive letter: "Z:" becomes
// `Z:\`.
func windowsVolumeRoot(letter string) string {
	if strings.HasSuffix(letter, ":") {
		return letter + `\`
	}
	return letter
}

// WindowsTaskCommandLine is the single command-line string schtasks stores for
// the login task: the same rclone argument vector the launchd plist and the
// systemd unit carry, as one string, because that is what /TR takes.
func WindowsTaskCommandLine(p MountPlan) string {
	parts := append([]string{p.RcloneBin}, p.Args()...)
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

// schtasksCreateArgs is `schtasks /Create /SC ONLOGON` for the login task.
// /F overwrites an existing task, so `drive mount` is safe to run again.
func schtasksCreateArgs(taskName, commandLine string) []string {
	return []string{"/Create", "/F", "/SC", "ONLOGON", "/TN", taskName, "/TR", commandLine}
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
// error carrying the tool's own output.
func runSchtasks(args ...string) error {
	out, err := exec.Command("schtasks", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// mountWindows is the Windows half of `drive mount`: check the driver, write
// the rclone config, register the logon task with schtasks and start it, then
// wait for the kernel to report the drive letter. A foreground mount runs
// rclone in this process instead, which is what the mount proof and debugging
// use.
func mountWindows(p MountPlan, home string, c StorageConfig, foreground, dryRun bool) error {
	if err := CheckWinFsp(p.GOOS, fileExists); err != nil {
		return err
	}
	commandLine := WindowsTaskCommandLine(p)
	if dryRun {
		fmt.Printf("--- %s ---\n%s", p.ConfigPath, RcloneConfigRedacted(c))
		fmt.Printf("--- Task Scheduler task %s ---\n%s\n", WindowsTaskName, commandLine)
		fmt.Printf("--- would run ---\n%s\n", commandLine)
		return nil
	}
	if err := WriteFileAtomic(p.ConfigPath, []byte(RcloneConfig(c)), 0o600); err != nil {
		return err
	}
	if foreground {
		return mountForeground(p, home)
	}
	// Registering the task is the enable half, running it is the start half,
	// the same two steps the Linux path takes with systemctl.
	if err := runSchtasks(schtasksCreateArgs(WindowsTaskName, commandLine)...); err != nil {
		return fmt.Errorf("create the login task: %w", err)
	}
	if err := runSchtasks(schtasksRunArgs(WindowsTaskName)...); err != nil {
		return fmt.Errorf("start the login task: %w", err)
	}
	if err := waitMounted("windows", home); err != nil {
		return err
	}
	fmt.Printf("Mounted at %s\n", p.MountDir)
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
func stopWindowsMount(home string) error {
	if present, err := windowsTaskPresent(WindowsTaskName); err == nil && present {
		_ = runSchtasks(schtasksEndArgs(WindowsTaskName)...)
	}
	letter, err := windowsMountLetter()
	if err != nil {
		return err
	}
	if windowsVolumeMounted(letter) {
		return fmt.Errorf("unmount %s: still mounted after stopping the login task", letter)
	}
	return nil
}

// fileExists is the real file probe the WinFsp check uses.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
