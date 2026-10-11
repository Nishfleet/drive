package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The api Worker's own answer for GET /v1/export, exactly the shape
// workers/api/src/export-routes.js returns.
const exportBody = `{
  "generatedAt": "2026-09-30T12:00:00.000Z",
  "account": {"id": "acct_1", "name": "Nish", "email": "nish@example.com"},
  "keys": [
    {"keyId": "k1", "name": "mac", "kind": "device", "prefix": "u/acct_1/",
     "capabilities": ["list", "read", "write", "delete"],
     "createdAt": 1759000000, "lastSeenAt": null, "revokedAt": null}
  ],
  "files": [
    {"path": "/notes.txt", "name": "notes.txt", "parent": "/", "sizeBytes": 120,
     "modifiedAt": "2026-09-30T10:00:00Z", "indexedAt": "2026-09-30T10:00:01Z"}
  ],
  "versions": [
    {"b2FileId": "f1", "path": "/notes.txt", "sizeBytes": 120,
     "createdAt": 1759000000000, "hiddenAt": null, "deletedAt": null}
  ],
  "complete": true,
  "next": {"fileCursor": null, "versionCursor": null}
}`

// exportServer stands in for the api Worker: it answers the one route with
// `body`, and records the Authorization header so a test can prove the export
// was requested with the device token the account gate needs.
func exportServer(t *testing.T, body string) (*httptest.Server, *string) {
	t.Helper()
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("Authorization")
		if r.URL.Path != EXPORT_PATH {
			t.Errorf("export called %s, want %s", r.URL.Path, EXPORT_PATH)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet {
			t.Errorf("export used %s, want GET", r.Method)
		}
		w.Header().Set("content-type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server, &seen
}

// exportHome writes the credentials `drive init` leaves, so runExport finds
// the api Worker and the device token the export is gated on.
func exportHome(t *testing.T, apiBase, token string) string {
	t.Helper()
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{
		APIBase:     apiBase,
		DeviceToken: token,
		AccountID:   "acct_1",
		AccountName: "Nish",
	}); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestExportWritesTheAccountDataToAFile(t *testing.T) {
	server, seen := exportServer(t, exportBody)
	home := exportHome(t, server.URL, "dtok_test")

	out := filepath.Join(home, "account.json")
	if err := runExport([]string{"--home", home, "--out", out}); err != nil {
		t.Fatal(err)
	}

	if *seen != "Bearer dtok_test" {
		t.Errorf("export sent Authorization %q, want the device token as a bearer", *seen)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read the export: %v", err)
	}
	var document ExportDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("the export is not the document format: %v", err)
	}
	if document.Account.Email != "nish@example.com" {
		t.Errorf("export account email = %q, want nish@example.com", document.Account.Email)
	}
	if len(document.Files) != 1 || document.Files[0].Path != "/notes.txt" {
		t.Errorf("export files = %+v, want the one indexed file", document.Files)
	}
	if len(document.Keys) != 1 || document.Keys[0].KeyID != "k1" {
		t.Errorf("export keys = %+v, want the one key", document.Keys)
	}
	if len(document.Versions) != 1 || document.Versions[0].B2FileID != "f1" {
		t.Errorf("export versions = %+v, want the one version", document.Versions)
	}
	// A key that has never been seen is null, not an epoch instant: the saved
	// document must not claim the key was last used in 1970.
	if document.Keys[0].LastSeenAt != nil {
		t.Errorf("lastSeenAt = %v, want null for a key never seen", *document.Keys[0].LastSeenAt)
	}
}

func TestExportWritesTheFileModeCredentialsGet(t *testing.T) {
	server, _ := exportServer(t, exportBody)
	home := exportHome(t, server.URL, "dtok_test")
	out := filepath.Join(home, "account.json")
	if err := runExport([]string{"--home", home, "--out", out}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("the export is mode %o, want 0600: it names the account's keys", perm)
	}
}

func TestExportRefusesAMachineThatIsNotSignedIn(t *testing.T) {
	home := t.TempDir() // no credentials file at all
	err := runExport([]string{"--home", home})
	if err == nil {
		t.Fatal("export on an unsigned-in machine must fail, not write an empty document")
	}
	if !strings.Contains(err.Error(), "drive login") {
		t.Errorf("the failure should say what to do next, got: %v", err)
	}
}

func TestExportReportsTheWorkersRefusalRatherThanAnEmptyDocument(t *testing.T) {
	// A 401 from the gate: the export must carry the Worker's own sentence,
	// never an empty document that reads as "you have no files".
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"Sign in to export your drive."}`))
	}))
	defer server.Close()
	home := exportHome(t, server.URL, "dtok_dead")

	err := runExport([]string{"--home", home})
	if err == nil {
		t.Fatal("a refused export must be an error, not an empty document")
	}
	if !strings.Contains(err.Error(), "Sign in to export your drive.") {
		t.Errorf("the error should carry the Worker's sentence, got: %v", err)
	}
}

func TestExportRejectsAnUnexpectedArgument(t *testing.T) {
	home := t.TempDir()
	if err := runExport([]string{"--home", home, "extra"}); err == nil {
		t.Fatal("an unexpected argument must be refused")
	}
}

func TestExportWalksEveryPageAndMergesThem(t *testing.T) {
	// The route is a bounded page, so a drive larger than one page is walked
	// cursor by cursor here and merged into the one document the person saves.
	// Two pages: the first reports `complete: false` and a cursor, the second
	// completes. The saved document must carry both pages' files, and the
	// keys exactly once (the route reads the whole key list on every page).
	pages := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json; charset=utf-8")
		pages++
		if r.URL.Query().Get("fileCursor") == "" {
			fmt.Fprint(w, `{"account":{"id":"acct_1","name":"N","email":"n@x.com"},
        "keys":[{"keyId":"k1","name":"mac","kind":"device","prefix":"u/a/",
                 "capabilities":[],"createdAt":1,"lastSeenAt":null,"revokedAt":null}],
        "files":[{"path":"/a.txt","name":"a.txt","parent":"/","sizeBytes":1}],
        "complete":false,"next":{"fileCursor":"/a.txt","versionCursor":null}}`)
			return
		}
		fmt.Fprint(w, `{"account":{"id":"acct_1","name":"N","email":"n@x.com"},
        "keys":[{"keyId":"k1","name":"mac","kind":"device","prefix":"u/a/",
                 "capabilities":[],"createdAt":1,"lastSeenAt":null,"revokedAt":null}],
        "files":[{"path":"/b.txt","name":"b.txt","parent":"/","sizeBytes":2}],
        "complete":true,"next":{"fileCursor":null,"versionCursor":null}}`)
	}))
	defer server.Close()
	home := exportHome(t, server.URL, "dtok_test")

	out := filepath.Join(home, "account.json")
	if err := runExport([]string{"--home", home, "--out", out}); err != nil {
		t.Fatal(err)
	}
	if pages != 2 {
		t.Errorf("the export made %d requests, want 2 (one page, then the cursor)", pages)
	}
	raw, _ := os.ReadFile(out)
	var document ExportDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if len(document.Files) != 2 {
		t.Errorf("export files = %d, want both pages' files merged", len(document.Files))
	}
	if len(document.Keys) != 1 {
		t.Errorf("export keys = %d, want the one key (not doubled by paging)", len(document.Keys))
	}
	if !document.Complete {
		t.Error("the merged document should be complete")
	}
}

func TestExportStopsWhenAPageNeverCompletes(t *testing.T) {
	// A server that always reports `complete: false` with a moving cursor
	// would otherwise loop forever holding a hung terminal. The walk is
	// bounded, so it gives up with a named error and writes nothing.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json; charset=utf-8")
		// A cursor that moves by one each time, so the loop's own page bound
		// is what stops it.
		n := r.URL.Query().Get("n")
		step := 0
		fmt.Sscanf(n, "%d", &step)
		fmt.Fprintf(w, `{"account":{"id":"acct_1","name":"N","email":"n@x.com"},
        "keys":[],"files":[],"complete":false,
        "next":{"fileCursor":"/f%d","versionCursor":null}}`, step+1)
	}))
	defer server.Close()
	home := exportHome(t, server.URL, "dtok_test")

	done := make(chan error, 1)
	go func() { done <- runExport([]string{"--home", home}) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a server that never completes must end in an error, not a hang")
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the export loop did not stop against a server that never completes")
	}
}
