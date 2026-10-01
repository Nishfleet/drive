package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// `drive branch`, `drive branches`, `drive diff`, `drive approve` and
// `drive discard` against a stand-in api Worker: the same JSON
// src/branches.js returns, served by net/http/httptest, so the commands'
// parsing, their words and the token they carry are tested without a network.

// branchServer is one httptest server that answers every branch route and
// records the requests, so a test can assert the CLI asked for the right
// path with the right credential. The body is read in the handler because the
// server closes it once the handler returns.
type branchCall struct {
	Method string
	Path   string
	Auth   string
	Body   map[string]string
}

func branchServer(t *testing.T) (*httptest.Server, *[]branchCall) {
	t.Helper()
	calls := &[]branchCall{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := branchCall{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("authorization")}
		body := map[string]string{}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		call.Body = body
		*calls = append(*calls, call)
		w.Header().Set("content-type", "application/json; charset=utf-8")
		switch {
		case r.Method == "POST" && r.URL.Path == BRANCHES_PATH:
			writeJSON(t, w, 201, `{"branch":{"name":"work","sourcePrefix":"/Photos","branchPrefix":"/.branches/work","state":"open","files":2}}`)
		case r.Method == "GET" && r.URL.Path == BRANCHES_PATH:
			writeJSON(t, w, 200, `{"branches":[{"name":"work","sourcePrefix":"/Photos","state":"open","changed":3,"sourceChanged":1}]}`)
		case r.Method == "GET" && r.URL.Path == BRANCHES_PATH+"/work":
			writeJSON(t, w, 200, `{"branch":{"name":"work","state":"open"},"diff":{"added":["new.txt"],"changed":["a.txt"],"removed":[],"sourceChanged":["a.txt"]}}`)
		case r.Method == "POST" && r.URL.Path == BRANCHES_PATH+"/work/approve":
			writeJSON(t, w, 200, `{"name":"work","state":"approved","applied":{"added":["new.txt"],"changed":["a.txt"],"removed":[]}}`)
		case r.Method == "POST" && r.URL.Path == BRANCHES_PATH+"/work/discard":
			writeJSON(t, w, 200, `{"name":"work","state":"discarded","removed":2}`)
		default:
			writeJSON(t, w, 404, `{"error":"No such branch."}`)
		}
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func writeJSON(t *testing.T, w http.ResponseWriter, status int, body string) {
	t.Helper()
	w.WriteHeader(status)
	if _, err := w.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
}

func signedInHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{
		APIBase:     "https://api.example.invalid",
		DeviceToken: "devtok",
		AccountID:   "acct-1",
		AccountName: "Test drive",
	}); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestRunBranchCopiesAndPrintsTheBranch(t *testing.T) {
	server, requests := branchServer(t)
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runBranch([]string{"--api", server.URL, "--home", home, "--name", "work", "/Photos"}); err != nil {
			t.Fatalf("runBranch: %v", err)
		}
	})
	if !strings.Contains(out, `created branch "work" from /Photos (2 files)`) {
		t.Errorf("output = %q", out)
	}
	if len(*requests) != 1 {
		t.Fatalf("requests = %d, want 1", len(*requests))
	}
	last := (*requests)[0]
	if last.Path != BRANCHES_PATH {
		t.Errorf("path = %q, want %q", last.Path, BRANCHES_PATH)
	}
	if last.Auth != "Bearer devtok" {
		t.Errorf("authorization = %q, want the device token", last.Auth)
	}
	if last.Body["folder"] != "/Photos" || last.Body["name"] != "work" {
		t.Errorf("body = %v", last.Body)
	}
}

func TestRunBranchDefaultsTheNameToTheFolder(t *testing.T) {
	server, requests := branchServer(t)
	home := signedInHome(t)
	if err := runBranch([]string{"--api", server.URL, "--home", home, "/Photos"}); err != nil {
		t.Fatalf("runBranch: %v", err)
	}
	if (*requests)[0].Body["name"] != "Photos" {
		t.Errorf("default name = %q, want the folder's name", (*requests)[0].Body["name"])
	}
}

func TestRunBranchesListsAndFlagsTheOriginalDrift(t *testing.T) {
	server, _ := branchServer(t)
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runBranches([]string{"--api", server.URL, "--home", home}); err != nil {
			t.Fatalf("runBranches: %v", err)
		}
	})
	if !strings.Contains(out, "work\topen\t3 changed\tfrom /Photos") {
		t.Errorf("output = %q", out)
	}
	if !strings.Contains(out, "the original changed") {
		t.Errorf("a drifted original must be named: %q", out)
	}
}

func TestRunDiffPrintsEveryList(t *testing.T) {
	server, _ := branchServer(t)
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runDiff([]string{"--api", server.URL, "--home", home, "work"}); err != nil {
			t.Fatalf("runDiff: %v", err)
		}
	})
	for _, want := range []string{"added    new.txt", "changed  a.txt", "approve will stop: a.txt"} {
		if !strings.Contains(out, want) {
			t.Errorf("output %q missing %q", out, want)
		}
	}
}

func TestRunApproveAndDiscard(t *testing.T) {
	server, _ := branchServer(t)
	home := signedInHome(t)
	approved := captureStdout(t, func() {
		if err := runApprove([]string{"--api", server.URL, "--home", home, "work"}); err != nil {
			t.Fatalf("runApprove: %v", err)
		}
	})
	if !strings.Contains(approved, `approved branch "work": 2 files copied back`) {
		t.Errorf("approve output = %q", approved)
	}
	discarded := captureStdout(t, func() {
		if err := runDiscard([]string{"--api", server.URL, "--home", home, "work"}); err != nil {
			t.Fatalf("runDiscard: %v", err)
		}
	})
	if !strings.Contains(discarded, `discarded branch "work" (2 files removed; the original is untouched)`) {
		t.Errorf("discard output = %q", discarded)
	}
}

func TestBranchCommandsNeedASignedInDevice(t *testing.T) {
	home := t.TempDir() // no credentials.json
	err := runBranches([]string{"--api", "https://api.example.invalid", "--home", home})
	if err == nil || !strings.Contains(err.Error(), "not signed in") {
		t.Fatalf("err = %v, want the not-signed-in sentence", err)
	}
}

func TestDefaultBranchName(t *testing.T) {
	for in, want := range map[string]string{
		"/Photos":    "Photos",
		"/Photos/2":  "2",
		"/":          "root",
		"":           "root",
		"/My Photos": "branch", // the space is not a legal branch name
	} {
		if got := defaultBranchName(in); got != want {
			t.Errorf("defaultBranchName(%q) = %q, want %q", in, got, want)
		}
	}
}
