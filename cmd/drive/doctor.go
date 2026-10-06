// `drive doctor` (drive issue #562): the one block to paste into a support
// message, in the order a person reads it. Four things a support reply cannot
// work without and a person cannot assemble by hand: which build is running,
// whether the mount is up, what the mount's own log last said, and whether the
// account side answers at all.
//
// Nothing here is a second way to ask a question something else already
// answers. The version is versionText(), the same string `drive version`
// prints. The mount state is Mounted, the same kernel question `drive status`
// asks. The api answer is the same authenticated read readCostLine makes. The
// log is read from where the mount already writes it (mount.go's plan) or
// where journald already keeps it.

package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// docsTroubleshootingURL is the self-serve page for a person who has not
// written in yet, on the same host the CLI's default api base points at, so
// the link cannot drift from where the docs are published. It is printed at
// the foot of the block, so the copy a person pastes into a message also
// carries the page that may answer the question without a reply at all.
func docsTroubleshootingURL() string { return defaultAPIBase + "/docs/troubleshooting" }

// doctorTimeout bounds the api read. The whole point of the command is a block
// that comes back, so a Worker that never answers must not turn it into a hung
// terminal.
const doctorTimeout = 10 * time.Second

// defaultDoctorLogLines is how many lines of the mount's own log the block
// carries. Twenty lines is one mount's start-up plus the failure that
// followed it, which is what a support reply reads first.
const defaultDoctorLogLines = 20

// runDoctor is `drive doctor`: print the block. It never fails the run for one
// part of the block it could not read, because a support message with half an
// answer beats no message: every line that could not be read names the reason
// on its own line instead, and the exit code stays zero so a person pasting
// the block into a ticket is not also told the command errored.
func runDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	logs := fs.Int("logs", defaultDoctorLogLines, "how many log lines to print (0 for none)")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q; `drive doctor` prints the support block and takes no command of its own", fs.Arg(0))
	}
	if *logs < 0 {
		return errors.New("--logs counts lines, so it cannot be below zero; use 0 for no log lines")
	}
	home := common.home
	goos := CurrentGOOS()
	fmt.Println("drive doctor: the block to paste into a support message")
	fmt.Println()
	printDoctorVersions(os.Stdout, common.rclone)
	printDoctorMount(os.Stdout, goos, home)
	printDoctorLogs(os.Stdout, goos, home, *logs)
	printDoctorAPI(os.Stdout, home, *api)
	fmt.Println()
	fmt.Printf("What to try first: %s\n", docsTroubleshootingURL())
	return nil
}

// printDoctorVersions prints which builds are running: drive's own version
// (versionText, the string `drive version` prints), the rclone the mount
// actually runs, and the platform. An rclone that cannot be resolved or
// cannot answer is named rather than skipped: "rclone: not found" is itself
// the answer for a mount that never started.
func printDoctorVersions(w io.Writer, rcloneBin string) {
	fmt.Fprintf(w, "drive:  %s\n", versionText())
	rclone := resolvedRclone(rcloneBin)
	if v, err := InstalledRcloneVersion(rclone); err == nil {
		fmt.Fprintf(w, "rclone: %s\n", v)
	} else {
		fmt.Fprintf(w, "rclone: %s\n", rcloneReason(rclone, err))
	}
	fmt.Fprintf(w, "os:     %s/%s\n", runtime.GOOS, runtime.GOARCH)
}

// resolvedRclone is the rclone path the mount would run, or the empty string
// when there is none. ResolveRclone's own error is reported by the caller, so
// the path is all this returns.
func resolvedRclone(rcloneBin string) string {
	rclone, err := ResolveRclone(rcloneBin)
	if err != nil {
		return ""
	}
	return rclone
}

// rcloneReason is the line `drive doctor` prints for the rclone version: what
// was found and why no version came back, in the words the install hint uses.
func rcloneReason(rclone string, err error) string {
	if rclone == "" {
		return "not found; install rclone and run `drive mount` again"
	}
	return fmt.Sprintf("%s does not report a version (%s)", filepath.Base(rclone), firstLine(err.Error()))
}

// printDoctorMount prints the mount state and where it is, which is the
// question that answers most support messages. The three branches are
// renderMountState's (status.go): mounted and answering, mounted but not
// answering, or not mounted. Each line that names a path names the log beside
// it, so the next thing to read is on the same line as the finding.
func printDoctorMount(w io.Writer, goos, home string) {
	on, err := Mounted(goos, home)
	if err != nil {
		fmt.Fprintf(w, "mount:  unknown (%s)\n", firstLine(err.Error()))
		return
	}
	mountDir := DefaultMountDir(home)
	if goos == "windows" && on {
		if letter, err := windowsMountLetter(); err == nil {
			mountDir = windowsVolumeRoot(letter)
		}
	}
	switch {
	case on && folderAnswers(mountDir):
		fmt.Fprintf(w, "mount:  mounted at %s\n", mountDir)
	case on:
		fmt.Fprintf(w, "mount:  mounted at %s, but the folder does not answer\n", mountDir)
		fmt.Fprintf(w, "        next: read %s\n", mountLogHint(goos, home))
	default:
		fmt.Fprintf(w, "mount:  not mounted (the drive folder would be %s)\n", mountDir)
		fmt.Fprintf(w, "        next: run `drive mount`\n")
	}
}

// folderAnswers is the same bound `drive status` puts on a folder read: a FUSE
// mount whose backing store has gone away blocks a ReadDir, so the read is
// bounded and a timeout counts as "not answering" rather than hanging the
// command.
func folderAnswers(mountDir string) bool {
	_, err := countEntries(mountDir, 2*time.Second)
	return err == nil
}

// printDoctorLogs prints the mount's own last lines, read from where the mount
// already puts them: the launchd item on macOS redirects rclone's output to
// ~/.config/drive/mount.log (mount.go's plan), and on Linux the unit's log is
// journald's, read with the stock journalctl. A log that cannot be read is a
// named line, not a blank one: "the log is empty" is itself the answer when a
// person reports a mount that never started.
func printDoctorLogs(w io.Writer, goos, home string, lines int) {
	if lines == 0 {
		fmt.Fprintln(w, "log:    skipped (--logs 0)")
		return
	}
	if goos == "linux" {
		printDoctorJournal(w, home, lines)
		return
	}
	printDoctorLogFile(w, filepath.Join(DefaultConfigDir(home), "mount.log"), lines)
}

// printDoctorLogFile prints the tail of a log file this CLI or its login item
// wrote. Every branch ends with a line, so a missing or empty log reads as an
// answer.
func printDoctorLogFile(w io.Writer, path string, lines int) {
	tail, err := tailFile(path, lines)
	if err != nil {
		fmt.Fprintf(w, "log:    cannot read %s (%s)\n", path, firstLine(err.Error()))
		return
	}
	if len(tail) == 0 {
		fmt.Fprintf(w, "log:    %s is empty\n", path)
		return
	}
	fmt.Fprintf(w, "log:    last %d line(s) of %s\n", len(tail), path)
	for _, line := range tail {
		fmt.Fprintf(w, "        %s\n", line)
	}
}

// printDoctorJournal reads the unit's log from journald, the stock place a
// systemd user unit's output goes. journalctl missing or unreadable falls back
// to the mount log the detached mount also writes (mount.go's
// startLinuxMountDetached), which is the only log a container without a user
// bus has. journalctl is a literal binary with a fixed flag list, and
// exec.Command takes an argument vector and runs no shell, so nothing from the
// command line or from a config file reaches it.
func printDoctorJournal(w io.Writer, home string, lines int) {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- literal binary "journalctl" with a fixed flag list; no argument comes from input. exec.Command takes an argument vector, not a shell.
	out, err := exec.Command("journalctl", "--user", "-u", SystemdUnitName, "-n", fmt.Sprint(lines), "--no-pager", "--output", "short").CombinedOutput()
	text := strings.TrimRight(string(out), "\n")
	if err != nil || strings.TrimSpace(text) == "" || journaldHasNoEntries(text) {
		printDoctorLogFile(w, filepath.Join(DefaultConfigDir(home), "mount.log"), lines)
		return
	}
	fmt.Fprintf(w, "log:    last %d line(s) of journalctl --user -u %s\n", lines, SystemdUnitName)
	for _, line := range strings.Split(text, "\n") {
		fmt.Fprintf(w, "        %s\n", line)
	}
}

// journaldHasNoEntries reports whether journalctl's answer is its own "there
// is nothing here" banner, which is what a unit that has never logged says.
// Printing the banner as a log line reads as gibberish, so it is not a line.
func journaldHasNoEntries(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-- No entries") || strings.HasPrefix(line, "-- Logs begin") {
			continue
		}
		return false
	}
	return true
}

// tailFile reads the last n lines of a text file. A file that cannot be opened
// is an error the caller names, because an absent log is a real answer to
// "what did the mount last say" and must never read as an empty one.
//
// A count of zero or less returns nothing rather than reaching the ring
// buffer's modulo, which divides by zero on the first line: the one caller
// (printDoctorLogs) guards the flag, so this is the second line of that same
// guard.
func tailFile(path string, n int) ([]string, error) {
	if n <= 0 {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	ring := make([]string, n)
	filled := 0
	next := 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		// A ring of the last n lines, so a mount that has been up for weeks
		// does not put a million-line log into a support message.
		ring[next] = line
		next = (next + 1) % n
		if filled < n {
			filled++
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if filled < n {
		return ring[:filled], nil
	}
	// The oldest line is the one the next write would have overwritten.
	return append(ring[next:], ring[:next]...), nil
}

// printDoctorAPI prints whether the account side answers, on the same
// authenticated read `drive status` makes (readCostLine's endpoint), so the
// two commands cannot disagree about it. A device that is not signed in gets
// the reason rather than a timeout, and the address is printed beside the
// answer because "the api is unreachable" is only actionable together with
// which address was tried.
func printDoctorAPI(w io.Writer, home, apiFlag string) {
	base, err := resolveAPIBase(home, apiFlag)
	if err != nil {
		fmt.Fprintf(w, "api:    unknown (%s)\n", firstLine(err.Error()))
		return
	}
	if strings.TrimSpace(base) == "" {
		fmt.Fprintln(w, "api:    not signed in on this device (run `drive login`, or pass --api <url>)")
		return
	}
	creds, err := LoadCredentials(home)
	if err != nil {
		fmt.Fprintf(w, "api:    unknown (%s)\n", firstLine(err.Error()))
		return
	}
	if reason := doctorAPIReason(base, creds.DeviceToken); reason != "" {
		fmt.Fprintf(w, "api:    %s (%s)\n", reason, base)
		return
	}
	fmt.Fprintf(w, "api:    reachable (%s)\n", base)
}

// doctorAPIReason does the reachability read and returns the reason it failed,
// or "" when the Worker answered. The endpoint is USAGE_PATH: a device that
// can read its own usage is signed in, reachable and answered, which is the
// whole question, so no second endpoint is introduced for it.
func doctorAPIReason(apiBase, token string) string {
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return firstLine(err.Error())
	}
	req, err := http.NewRequest(http.MethodGet, base+USAGE_PATH, nil)
	if err != nil {
		return firstLine(err.Error())
	}
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: doctorTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return firstLine(fail("offline").Error())
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
		return ""
	case http.StatusUnauthorized, http.StatusForbidden:
		return "refused the device token; run `drive login` on this device again"
	default:
		return fmt.Sprintf("answered %d", resp.StatusCode)
	}
}
