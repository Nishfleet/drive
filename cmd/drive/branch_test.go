package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// `drive branch`, `drive branches`, `drive diff`, `drive approve` and
// `drive discard` against a stand-in that serves BOTH /api/branches* and
// /v1/keys (drive#156): one host fronts both families, the same shape
// credentials.APIBase uses in production.

// branchCall is one request the CLI made. The body is read in the handler
// because the server closes it once the handler returns.
type branchCall struct {
	Method string
	Path   string
	Auth   string
	Body   map[string]string
}

// branchMintSecret is a distinctive secret the stand-in mints, so a test can
// prove runBranch never prints it (drive#75).
const branchMintSecret = "sk_branch_secret_must_not_print"

type branchStandIn struct {
	createConflict bool
	failMint       bool
}

func branchServer(t *testing.T) (*httptest.Server, *[]branchCall) {
	t.Helper()
	return branchServerWith(t, branchStandIn{})
}

func branchServerWith(t *testing.T, cfg branchStandIn) (*httptest.Server, *[]branchCall) {
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
			if cfg.createConflict {
				writeJSON(t, w, 409, `{"error":"A branch with that name is still open. Choose another name, or discard the open branch first."}`)
				return
			}
			name := body["name"]
			if name == "" {
				name = "work"
			}
			writeJSON(t, w, 201, `{"branch":{"name":"`+name+`","sourcePrefix":"/Photos","branchPrefix":"/.branches/`+name+`","state":"open","files":2}}`)
		case r.Method == "GET" && r.URL.Path == BRANCHES_PATH:
			writeJSON(t, w, 200, `{"branches":[{"name":"work","sourcePrefix":"/Photos","state":"open","changed":3,"sourceChanged":1}]}`)
		case r.Method == "GET" && strings.HasPrefix(r.URL.Path, BRANCHES_PATH+"/") && !strings.Contains(r.URL.Path[len(BRANCHES_PATH)+1:], "/"):
			name := r.URL.Path[len(BRANCHES_PATH)+1:]
			writeJSON(t, w, 200, `{"branch":{"name":"`+name+`","sourcePrefix":"/Photos","branchPrefix":"/.branches/`+name+`","state":"open","files":2},"diff":{"added":["new.txt"],"changed":["a.txt"],"removed":[],"sourceChanged":["a.txt"]}}`)
		case r.Method == "POST" && r.URL.Path == BRANCHES_PATH+"/work/approve":
			writeJSON(t, w, 200, `{"name":"work","state":"approved","applied":{"added":["new.txt"],"changed":["a.txt"],"removed":[]}}`)
		case r.Method == "POST" && r.URL.Path == BRANCHES_PATH+"/work/discard":
			writeJSON(t, w, 200, `{"name":"work","state":"discarded","removed":2}`)
		case r.Method == "POST" && r.URL.Path == keysPath:
			if cfg.failMint {
				writeJSON(t, w, 500, `{"error":"The api Worker could not mint a key."}`)
				return
			}
			name := body["name"]
			if name == "" {
				name = "work"
			}
			writeJSON(t, w, 201, `{"keyId":"key_`+name+`","accessKeyId":"ak_`+name+`","secret":"`+branchMintSecret+`","prefix":"u/acct-1/.branches/`+name+`/","capabilities":["list","read","write"]}`)
		case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, keysPath+"/"):
			w.WriteHeader(http.StatusNoContent)
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

func callWith(calls []branchCall, method, path string) *branchCall {
	for i := range calls {
		if calls[i].Method == method && calls[i].Path == path {
			return &calls[i]
		}
	}
	return nil
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
	create := callWith(*requests, "POST", BRANCHES_PATH)
	if create == nil {
		t.Fatalf("requests = %v, want POST %s", *requests, BRANCHES_PATH)
	}
	if create.Auth != "Bearer devtok" {
		t.Errorf("authorization = %q, want the device token", create.Auth)
	}
	if create.Body["folder"] != "/Photos" || create.Body["name"] != "work" {
		t.Errorf("body = %v", create.Body)
	}
}

func TestRunBranchMintsAScopedKeyWithNoDelete(t *testing.T) {
	server, requests := branchServer(t)
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runBranch([]string{"--api", server.URL, "--home", home, "--name", "work", "/Photos"}); err != nil {
			t.Fatalf("runBranch: %v", err)
		}
	})
	mint := callWith(*requests, "POST", keysPath)
	if mint == nil {
		t.Fatalf("requests = %v, want POST %s", *requests, keysPath)
	}
	if mint.Body["kind"] != "branch" || mint.Body["name"] != "work" {
		t.Errorf("mint body = %v, want kind=branch name=work", mint.Body)
	}
	if mint.Auth != "Bearer devtok" {
		t.Errorf("mint authorization = %q, want the device token", mint.Auth)
	}
	wantPrefix := "u/acct-1/.branches/work/"
	if !strings.Contains(out, wantPrefix) {
		t.Errorf("output %q missing prefix %q", out, wantPrefix)
	}
	if !strings.Contains(out, "no delete") {
		t.Errorf("output %q must say the key has no delete", out)
	}
	if !strings.Contains(out, "DRIVE_ACCESS_KEY_ID") || !strings.Contains(out, "DRIVE_SECRET_ACCESS_KEY") {
		t.Errorf("output %q must name the two env vars, never argv", out)
	}
	if strings.Contains(out, branchMintSecret) {
		t.Errorf("output leaked the secret")
	}
	if strings.Contains(out, "ak_work") {
		t.Errorf("output leaked the access key id")
	}
	stored, err := branchKeyFor(home, "work")
	if err != nil {
		t.Fatal(err)
	}
	if stored == nil {
		t.Fatal("expected the branch key to be stored")
	}
	if stored.Prefix != wantPrefix {
		t.Errorf("stored prefix = %q, want %q", stored.Prefix, wantPrefix)
	}
	for _, cap := range stored.Capabilities {
		if cap == "delete" {
			t.Fatalf("stored capabilities include delete: %v", stored.Capabilities)
		}
	}
	info, err := os.Stat(BranchKeysPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("branch-keys.json mode = %o, want 0600", info.Mode().Perm())
	}
}

func TestRunBranchRecoversAKeyWhenTheNameIsAlreadyOpen(t *testing.T) {
	server, requests := branchServerWith(t, branchStandIn{createConflict: true})
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runBranch([]string{"--api", server.URL, "--home", home, "--name", "work", "/Photos"}); err != nil {
			t.Fatalf("runBranch: %v", err)
		}
	})
	if !strings.Contains(out, `branch "work" is already open`) {
		t.Errorf("output = %q, want the recovery sentence", out)
	}
	if callWith(*requests, "GET", BRANCHES_PATH+"/work") == nil {
		t.Errorf("requests = %v, want GET of the open branch", *requests)
	}
	mint := callWith(*requests, "POST", keysPath)
	if mint == nil || mint.Body["kind"] != "branch" {
		t.Errorf("requests = %v, want a branch mint after the 409", *requests)
	}
	stored, err := branchKeyFor(home, "work")
	if err != nil || stored == nil {
		t.Fatalf("stored key = %v err = %v, want a recovered key", stored, err)
	}
}

func TestRunBranchReusesAStoredKeyOnASecondRun(t *testing.T) {
	server, _ := branchServer(t)
	home := signedInHome(t)
	_ = captureStdout(t, func() {
		if err := runBranch([]string{"--api", server.URL, "--home", home, "--name", "work", "/Photos"}); err != nil {
			t.Fatalf("first runBranch: %v", err)
		}
	})
	conflict, requests := branchServerWith(t, branchStandIn{createConflict: true})
	_ = captureStdout(t, func() {
		if err := runBranch([]string{"--api", conflict.URL, "--home", home, "--name", "work", "/Photos"}); err != nil {
			t.Fatalf("second runBranch: %v", err)
		}
	})
	if callWith(*requests, "POST", keysPath) != nil {
		t.Errorf("second run minted again: %v", *requests)
	}
}

func TestRunBranchTellsThePersonToRetryWhenMintFails(t *testing.T) {
	server, _ := branchServerWith(t, branchStandIn{failMint: true})
	home := signedInHome(t)
	err := runBranch([]string{"--api", server.URL, "--home", home, "--name", "work", "/Photos"})
	if err == nil {
		t.Fatal("expected mint failure")
	}
	if !strings.Contains(err.Error(), "key could not be minted") {
		t.Errorf("err = %v, want the mint-failed words", err)
	}
	if !strings.Contains(err.Error(), "same name") {
		t.Errorf("err = %v, want the retry next step", err)
	}
	stored, storeErr := branchKeyFor(home, "work")
	if storeErr != nil {
		t.Fatal(storeErr)
	}
	if stored != nil {
		t.Errorf("stored a key after a failed mint: %+v", stored)
	}
}

func TestRunBranchDefaultsTheNameToTheFolder(t *testing.T) {
	server, requests := branchServer(t)
	home := signedInHome(t)
	_ = captureStdout(t, func() {
		if err := runBranch([]string{"--api", server.URL, "--home", home, "/Photos"}); err != nil {
			t.Fatalf("runBranch: %v", err)
		}
	})
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
