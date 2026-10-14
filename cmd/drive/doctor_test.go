package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDoctorBlockHasEveryLabel(t *testing.T) {
	home := t.TempDir()
	var b strings.Builder
	printDoctorVersions(&b, "")
	printDoctorMount(&b, "plan9", home)
	printDoctorLogs(&b, "plan9", home, 20)
	printDoctorAPI(&b, home, "")
	got := b.String()
	want := []string{"drive:", "rclone:", "os:", "mount:", "log:", "api:"}
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("doctor block is missing its %q line:\n%s", w, got)
		}
	}
	if lines := countNonBlankLines(got); lines < len(want) {
		t.Fatalf("doctor block has %d non-blank lines, want at least one per label (%d):\n%s", lines, len(want), got)
	}
	for _, label := range want {
		for _, line := range strings.Split(got, "\n") {
			rest, ok := strings.CutPrefix(strings.TrimSpace(line), label)
			if !ok {
				continue
			}
			if strings.TrimSpace(rest) == "" {
				t.Errorf("doctor block's %q line says nothing:\n%s", label, got)
			}
			break
		}
	}
}

func TestJournaldBannerIsNotALogLine(t *testing.T) {
	for _, banner := range []string{
		"",
		"   \n\t",
		"-- No entries --",
		"-- Logs begin at Mon 2026-10-07 01:29:17 IST. --\n-- No entries --",
	} {
		if !journaldHasNoEntries(banner) {
			t.Errorf("journaldHasNoEntries(%q) = false, want true so the banner is not printed as a log line", banner)
		}
	}
	for _, line := range []string{
		"Oct 07 01:29:17 host drive-mount[1]: mounted",
		"-- Logs begin at Mon 2026-10-07 01:29:17 IST. --\nOct 07 01:29:17 host drive-mount[1]: mounted",
	} {
		if journaldHasNoEntries(line) {
			t.Errorf("journaldHasNoEntries(%q) = true, want false so a real log line is printed", line)
		}
	}
}

func TestWindowsMountLetterTokenPicksTheDriveLetter(t *testing.T) {
	command := `\"C:\\rclone.exe\" --config C:\\Users\\nish\\.config\\drive\\rclone.conf mount z: /mnt`
	letter, ok := windowsDriveLetterFromCommand(command)
	if !ok || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want \"Z:\", true", command, letter, ok)
	}
	if _, ok := windowsDriveLetterFromCommand("drive --mount /mnt/point"); ok {
		t.Error("a command with no drive-letter token answered with one")
	}
	if got := windowsVolumeRoot("Z:"); got != `Z:\` {
		t.Errorf("windowsVolumeRoot(\"Z:\") = %q, want %q", got, `Z:\`)
	}
}

func TestDoctorLogLinesAreNamedNotBlank(t *testing.T) {
	var b strings.Builder
	printDoctorLogFile(&b, filepath.Join(t.TempDir(), "no", "such", "mount.log"), 20)
	if got := b.String(); !strings.Contains(got, "cannot read") {
		t.Errorf("missing log = %q, want the named reason", got)
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "mount.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	b.Reset()
	printDoctorLogFile(&b, path, 20)
	if got := b.String(); !strings.Contains(got, "is empty") {
		t.Errorf("empty log = %q, want the named reason", got)
	}

	for _, goos := range []string{"darwin", "windows"} {
		if got := mountLogHint(goos, "/home/nish"); got != filepath.Join("/home/nish", ".config", "drive", "mount.log") {
			t.Errorf("mountLogHint(%q) = %q, want the mount.log the docs page names", goos, got)
		}
	}
	if got := mountLogHint("linux", "/home/nish"); !strings.Contains(got, "journalctl") || !strings.Contains(got, SystemdUnitName) {
		t.Errorf("mountLogHint(\"linux\") = %q, want the journalctl command the docs page names", got)
	}
}

func TestDoctorLogTailKeepsLastLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mount.log")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tail, err := tailFile(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 2 || tail[0] != "three" || tail[1] != "four" {
		t.Errorf("tailFile(path, 2) = %q, want [three four]", tail)
	}
}

func TestDoctorLogsZeroSkips(t *testing.T) {
	var b strings.Builder
	printDoctorLogs(&b, "plan9", t.TempDir(), 0)
	if got := b.String(); !strings.Contains(got, "skipped") {
		t.Errorf("--logs 0 = %q, want the skip line", got)
	}
}

func TestDoctorAPINotSignedIn(t *testing.T) {
	var b strings.Builder
	printDoctorAPI(&b, t.TempDir(), "")
	if got := b.String(); !strings.Contains(got, "not signed in") || !strings.Contains(got, "drive login") {
		t.Errorf("no credentials = %q, want the reason and the command", got)
	}
}

func TestDoctorAPIUnreachableNamesTheAddress(t *testing.T) {
	var b strings.Builder
	const tried = "https://127.0.0.1:1"
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: tried, DeviceToken: "dtok_test"}); err != nil {
		t.Fatal(err)
	}
	printDoctorAPI(&b, home, tried)
	got := doctorAPILine(b.String())
	if !strings.HasSuffix(got, "("+tried+")") {
		t.Errorf("unreachable api = %q, want the address it tried in brackets at the end", got)
	}
	if !strings.Contains(got, "offline") {
		t.Errorf("unreachable api = %q, want the offline answer, not a timeout or a blank", got)
	}
}

const refusedTokenAnswer = "refused the device token; run `drive login` on this device again"

func TestDoctorAPIRefusesADeadToken(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			}))
			t.Cleanup(server.Close)
			home := t.TempDir()
			if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: "dtok_dead"}); err != nil {
				t.Fatal(err)
			}
			var b strings.Builder
			printDoctorAPI(&b, home, "")
			if got := doctorAPILine(b.String()); got != refusedTokenAnswer+" ("+server.URL+")" {
				t.Errorf("refused token = %q, want %q (address in brackets)", got, refusedTokenAnswer)
			}
			if strings.Contains(b.String(), "dtok_dead") {
				t.Error("the api line prints the device token, which must never reach a pasted block")
			}
		})
	}
}

func TestDoctorAPIReachableNamesTheAddress(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != USAGE_PATH {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: "dtok_live"}); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	printDoctorAPI(&b, home, "")
	if want := "reachable (" + server.URL + ")"; doctorAPILine(b.String()) != want {
		t.Errorf("reachable api = %q, want %q", doctorAPILine(b.String()), want)
	}
}

func doctorAPILine(block string) string {
	for _, line := range strings.Split(block, "\n") {
		answer, ok := strings.CutPrefix(strings.TrimSpace(line), "api:")
		if ok {
			return strings.TrimSpace(answer)
		}
	}
	return ""
}

func TestDoctorAnswersAnyOtherStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: "dtok_live"}); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	printDoctorAPI(&b, home, "")
	if got, want := doctorAPILine(b.String()), "answered 503 ("+server.URL+")"; got != want {
		t.Errorf("other status = %q, want %q", got, want)
	}
}

func TestDoctorRejectsBadArguments(t *testing.T) {
	t.Setenv("DRIVE_API_URL", "")
	home := t.TempDir()
	if err := runDoctor([]string{"--home", home, "status"}); err == nil {
		t.Error("drive doctor took a subcommand; it prints the block and takes no command of its own")
	}
	if err := runDoctor([]string{"--home", home, "--logs", "-1"}); err == nil || !strings.Contains(err.Error(), "zero") {
		t.Errorf("--logs -1 = %v, want a refusal that says the count cannot be below zero", err)
	}
	if err := runDoctor([]string{"--home", home, "--no-such-flag"}); err != errFlagParse {
		t.Errorf("an unknown flag = %v, want the flag-parse failure the other commands return", err)
	}
}

func TestDoctorDeclinedAPartIsNotAFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DRIVE_API_URL", "")
	if err := runDoctor([]string{"--home", home, "--logs", "0"}); err != nil {
		t.Errorf("drive doctor on a host with no log and no api = %v, want exit 0", err)
	}
}

func countNonBlankLines(s string) int {
	n := 0
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

func TestDoctorLogTailScrubsSecrets(t *testing.T) {
	const plain = "2026/10/07 10:00:00 NOTICE: mount ready at /home/u/Drive"
	cases := []struct{ name, line, secret string }{
		{"device token", "login ok token dtok_AbC123-xyz_9 saved", "dtok_AbC123-xyz_9"},
		{"bearer", "GET /usage Bearer abc.def-123 failed", "abc.def-123"},
		{"authorization", "Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"},
		{"sigv4 header", "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261007/auto/s3/aws4_request, SignedHeaders=host, Signature=deadbeef01", "AKIAEXAMPLE"},
		{"sigv4 header signature", "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/x, Signature=deadbeef01", "deadbeef01"},
		{"sigv4 no header name", "sent AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261007/auto/s3/aws4_request, Signature=cafe0123", "AKIAEXAMPLE"},
		{"presigned signature", "GET https://b.example/k?X-Amz-Signature=0123abcd&X-Amz-Expires=60", "0123abcd"},
		{"presigned credential", "GET https://b.example/k?X-Amz-Credential=AKIAEXAMPLE%2F2026&X-Amz-Date=1", "AKIAEXAMPLE"},
		{"presigned token", "GET https://b.example/k?a=1&X-Amz-Security-Token=FwoGZXIvYXdz", "FwoGZXIvYXdz"},
		{"plain Signature", "url ?Signature=abcdef99&x=1", "abcdef99"},
		{"access key equals", "access_key_id=AKIAEXAMPLE2 ok", "AKIAEXAMPLE2"},
		{"secret json", `{"secret_access_key": "wJalrXUtnFEMI", "n": 1}`, "wJalrXUtnFEMI"},
		{"session token colon", "session_token: IQoJb3JpZ2luX2Vj", "IQoJb3JpZ2luX2Vj"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "mount.log")
			if err := os.WriteFile(path, []byte(plain+"\n"+tc.line+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			var b strings.Builder
			printDoctorLogFile(&b, path, 20)
			got := b.String()
			if strings.Contains(got, tc.secret) {
				t.Errorf("secret %q survived: %q", tc.secret, got)
			}
			if !strings.Contains(got, "<redacted>") {
				t.Errorf("no <redacted> mark in %q", got)
			}
			if !strings.Contains(got, plain) {
				t.Errorf("ordinary line changed: %q", got)
			}
		})
	}
	if got := scrubLogLine(plain); got != plain {
		t.Errorf("scrubLogLine changed an ordinary line: %q", got)
	}
}

func TestDoctorAPIExplicitBaseWithoutTokenIsNotSignedIn(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	defer srv.Close()
	var b strings.Builder
	printDoctorAPI(&b, t.TempDir(), srv.URL)
	got := b.String()
	if !strings.Contains(got, "not signed in") || !strings.Contains(got, "drive login") || !strings.Contains(got, srv.URL) {
		t.Errorf("explicit --api, no token = %q, want the login line and the address", got)
	}
	if hit {
		t.Error("the api was called with an empty token")
	}
}

func TestTroubleshootingPageNamesWhatTheCodeUses(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "docs-site", "troubleshooting.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{SystemdUnitName, filepath.Base(filepath.Join(DefaultConfigDir("/h"), "mount.log"))} {
		if !strings.Contains(string(page), want) {
			t.Errorf("docs-site/troubleshooting.md does not mention %q", want)
		}
	}
}
