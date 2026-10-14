package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// `drive restore` talks to the two routes core/files-history.js serves. The
// server here answers with the same JSON, and records what the command sent,
// so the request and the printed lines are checked against that contract.

type restoreServer struct {
	versions []EarlierCopy
	posted   []map[string]string
}

func (s *restoreServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == versionsPath:
			_ = json.NewEncoder(w).Encode(map[string]any{"path": r.URL.Query().Get("path"), "versions": s.versions})
		case r.Method == http.MethodPost && r.URL.Path == restoreVersionPath:
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			s.posted = append(s.posted, body)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestRestoreTableEntryExistsAndHelpNamesIt(t *testing.T) {
	if _, ok := commands["restore"]; !ok {
		t.Fatal("the commands table has no restore entry")
	}
	if !strings.Contains(usage, "drive restore <file>") {
		t.Fatal("the help text does not document drive restore")
	}
}

func TestShortTimeKeepsTextItCannotParse(t *testing.T) {
	if got := shortTime("not a time"); got != "not a time" {
		t.Fatalf("shortTime changed unparseable text: %q", got)
	}
}

func newRestoreFixture(t *testing.T) (*restoreServer, *httptest.Server, string) {
	t.Helper()
	server := &restoreServer{versions: []EarlierCopy{
		{VersionID: "v-new", Size: 11, SavedAt: "2026-10-12T10:00:00Z", ReplacedAt: "2026-10-13T10:00:00Z", RestorableTill: "2026-11-12T10:00:00Z"},
		{VersionID: "v-old", Size: 5, SavedAt: "2026-10-10T10:00:00Z", ReplacedAt: "2026-10-12T10:00:00Z", RestorableTill: "2026-11-11T10:00:00Z"},
	}}
	srv := server.start(t)
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: srv.URL, DeviceToken: "dtok"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRIVE_API_URL", "")
	return server, srv, home
}

func TestRestoreWithNoFlagListsCopiesAndPostsNothing(t *testing.T) {
	server, srv, home := newRestoreFixture(t)
	defer srv.Close()
	out := captureStdout(t, func() {
		if err := runRestore([]string{"--home", home, "/a.txt"}); err != nil {
			t.Fatal(err)
		}
	})
	for _, want := range []string{"earlier copies of /a.txt", "1. ", "2. ", "permanently removed", "--copy N"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q is missing %q", out, want)
		}
	}
	if len(server.posted) != 0 {
		t.Errorf("listing posted a restore: %v", server.posted)
	}
}

func TestRestoreLatestAndCopyPostTheChosenVersion(t *testing.T) {
	server, srv, home := newRestoreFixture(t)
	defer srv.Close()
	captureStdout(t, func() {
		if err := runRestore([]string{"--home", home, "--latest", "/a.txt"}); err != nil {
			t.Fatal(err)
		}
		if err := runRestore([]string{"--home", home, "--copy", "2", "/a.txt"}); err != nil {
			t.Fatal(err)
		}
	})
	if len(server.posted) != 2 || server.posted[0]["versionId"] != "v-new" || server.posted[1]["versionId"] != "v-old" {
		t.Fatalf("posted %v, want v-new then v-old", server.posted)
	}
	if server.posted[0]["path"] != "/a.txt" {
		t.Errorf("path %q", server.posted[0]["path"])
	}
}

func TestRestoreRefusesACopyThatIsNotThere(t *testing.T) {
	_, srv, home := newRestoreFixture(t)
	defer srv.Close()
	captureStdout(t, func() {
		if err := runRestore([]string{"--home", home, "--copy", "9", "/a.txt"}); err == nil {
			t.Error("copy 9 of 2 was accepted")
		}
		if err := runRestore([]string{"--home", home, "--latest", "--copy", "1", "/a.txt"}); err == nil {
			t.Error("--latest with --copy was accepted")
		}
	})
}
