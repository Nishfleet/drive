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
	"regexp"
	"runtime"
	"strings"
	"time"
)

func docsTroubleshootingURL() string { return defaultAPIBase + "/docs/troubleshooting" }

const doctorTimeout = 10 * time.Second

const defaultDoctorLogLines = 20

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

func resolvedRclone(rcloneBin string) string {
	rclone, err := ResolveRclone(rcloneBin)
	if err != nil {
		return ""
	}
	return rclone
}

func rcloneReason(rclone string, err error) string {
	if rclone == "" {
		return "not found; install rclone and run `drive mount` again"
	}
	return fmt.Sprintf("%s does not report a version (%s)", filepath.Base(rclone), firstLine(err.Error()))
}

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

// A FUSE mount whose backing store has gone away blocks a ReadDir.
func folderAnswers(mountDir string) bool {
	_, err := countEntries(mountDir, 2*time.Second)
	return err == nil
}

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

var logSecretPatterns = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`\bdtok_[A-Za-z0-9_-]+`), `<redacted>`},
	{regexp.MustCompile(`(?i)(authorization["']?\s*[:=]\s*).*`), `${1}<redacted>`},
	{regexp.MustCompile(`(?i)(bearer\s+)[^\s"',;]+`), `${1}<redacted>`},
	{regexp.MustCompile(`(?i)\b(x-amz-signature|x-amz-credential|x-amz-security-token|signature|credential)=[^&\s"',]+`), `${1}=<redacted>`},
	{regexp.MustCompile(`(?i)\b(access_key_id|secret_access_key|session_token)(["']?\s*[:=]\s*["']?)[^\s"',&]+`), `${1}${2}<redacted>`},
}

func scrubLogLine(line string) string {
	for _, p := range logSecretPatterns {
		line = p.re.ReplaceAllString(line, p.with)
	}
	return line
}

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
		fmt.Fprintf(w, "        %s\n", scrubLogLine(line))
	}
}

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
		fmt.Fprintf(w, "        %s\n", scrubLogLine(line))
	}
}

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
	return append(ring[next:], ring[:next]...), nil
}

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
	if strings.TrimSpace(creds.DeviceToken) == "" {
		fmt.Fprintf(w, "api:    not signed in on this device (run `drive login`) (%s)\n", base)
		return
	}
	if reason := doctorAPIReason(base, creds.DeviceToken); reason != "" {
		fmt.Fprintf(w, "api:    %s (%s)\n", reason, base)
		return
	}
	fmt.Fprintf(w, "api:    reachable (%s)\n", base)
}

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
	client := newHTTPClient(doctorTimeout)
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
