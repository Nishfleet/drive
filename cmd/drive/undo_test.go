package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type undoStandIn struct {
	list       string
	postState  string
	pollStates []string
}

func undoServer(t *testing.T, cfg undoStandIn) (*httptest.Server, *[]branchCall) {
	t.Helper()
	calls := &[]branchCall{}
	list := cfg.list
	if list == "" {
		list = `{"rewinds":[` +
			`{"name":"old","sourcePrefix":"/Photos","state":"open","changedBy":"claude",` +
			`"createdAt":"2026-09-01T10:00:00Z","canRewind":true,` +
			`"files":{"added":["a.txt"],"changed":[],"removed":[],"count":1}},` +
			`{"name":"new","sourcePrefix":"/Docs","state":"open","changedBy":"codex",` +
			`"createdAt":"2026-10-04T09:00:00Z","canRewind":true,` +
			`"files":{"added":[],"changed":["b.txt"],"removed":["c.txt"],"count":2}}` +
			`]}`
	}
	pollIndex := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call := branchCall{Method: r.Method, Path: r.URL.Path, Auth: r.Header.Get("authorization")}
		*calls = append(*calls, call)
		w.Header().Set("content-type", "application/json; charset=utf-8")
		switch {
		case r.Method == "GET" && r.URL.Path == REWIND_PATH:
			writeJSON(t, w, 200, list)
		case r.Method == "GET" && r.URL.Path == REWIND_PATH+"/new":
			writeJSON(t, w, 200, `{"rewind":{"name":"new","sourcePrefix":"/Docs","state":"open",`+
				`"changedBy":"codex","createdAt":"2026-10-04T09:00:00Z","canRewind":true,`+
				`"files":{"added":[],"changed":["b.txt"],"removed":["c.txt"],"count":2}}}`)
		case r.Method == "GET" && r.URL.Path == REWIND_PATH+"/gone":
			writeJSON(t, w, 404, `{"error":"There is no branch with that name."}`)
		case r.Method == "POST" && r.URL.Path == REWIND_PATH+"/new":
			state := cfg.postState
			if state == "" {
				state = "discarded"
			}
			writeJSON(t, w, 202, `{"name":"new","state":"`+state+`","rewound":2,"changedBy":"codex"}`)
		case r.Method == "GET" && r.URL.Path == BRANCHES_PATH+"/new":
			state := "discarded"
			if pollIndex < len(cfg.pollStates) {
				state = cfg.pollStates[pollIndex]
				pollIndex++
			}
			writeJSON(t, w, 200, `{"branch":{"name":"new","sourcePrefix":"/Docs","state":"`+state+`",`+
				`"progress":{"kind":"rewind","done":2,"total":2}}}`)
		default:
			writeJSON(t, w, 404, `{"error":"No such branch."}`)
		}
	}))
	t.Cleanup(server.Close)
	return server, calls
}

func TestRunUndoRewindsTheNewestBranch(t *testing.T) {
	server, requests := undoServer(t, undoStandIn{list: `{"rewinds":[` +
		`{"name":"old","sourcePrefix":"/Photos","state":"open","changedBy":"claude",` +
		`"createdAt":"2026-09-01T10:00:00Z","canRewind":true,` +
		`"files":{"added":["a.txt"],"changed":[],"removed":[],"count":1}},` +
		`{"name":"new","sourcePrefix":"/Docs","state":"open","changedBy":"codex",` +
		`"createdAt":"2026-10-04T09:00:00Z","canRewind":true,` +
		`"files":{"added":[],"changed":["b.txt"],"removed":["c.txt"],"count":2}},` +
		`{"name":"stale","sourcePrefix":"/Docs","state":"open","changedBy":"grok",` +
		`"createdAt":"2026-11-01T09:00:00Z","canRewind":false,"unavailableReason":"window-closed",` +
		`"files":{"added":[],"changed":[],"removed":[],"count":9}}` +
		`]}`})
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runUndo([]string{"--api", server.URL, "--home", home}); err != nil {
			t.Fatalf("runUndo: %v", err)
		}
	})
	for _, want := range []string{
		"codex worked in /Docs: 2 files changed (0 added, 1 changed, 1 removed).",
		"  changed b.txt",
		"  removed c.txt",
		`rewound codex's work in branch "new" (2 files removed; the original is untouched)`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output = %q, want %q", out, want)
		}
	}
	posts := 0
	for _, call := range *requests {
		if call.Method == "POST" {
			posts++
			if call.Path != REWIND_PATH+"/new" {
				t.Errorf("POST %s, want %s/new", call.Path, REWIND_PATH)
			}
		}
		if call.Method == "DELETE" {
			t.Errorf("unexpected %s %s", call.Method, call.Path)
		}
	}
	if posts != 1 {
		t.Fatalf("POSTs = %d, want 1; requests = %v", posts, *requests)
	}
}

func TestRunUndoRewindsTheNamedBranch(t *testing.T) {
	server, requests := undoServer(t, undoStandIn{})
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runUndo([]string{"--api", server.URL, "--home", home, "new"}); err != nil {
			t.Fatalf("runUndo: %v", err)
		}
	})
	if !strings.Contains(out, "codex worked in /Docs") {
		t.Errorf("output = %q", out)
	}
	if callWith(*requests, "GET", REWIND_PATH) != nil {
		t.Errorf("a named branch must not read the list; requests = %v", *requests)
	}
	if callWith(*requests, "GET", REWIND_PATH+"/new") == nil {
		t.Errorf("GET %s/new missing; requests = %v", REWIND_PATH, *requests)
	}
	if callWith(*requests, "POST", REWIND_PATH+"/new") == nil {
		t.Errorf("POST %s/new missing; requests = %v", REWIND_PATH, *requests)
	}
	if len(*requests) != 2 {
		t.Errorf("requests = %v, want the preview and the rewind", *requests)
	}
}

func TestRunUndoSaysSoWhenNoBranchCanBeRewound(t *testing.T) {
	server, requests := undoServer(t, undoStandIn{list: `{"rewinds":[` +
		`{"name":"done","sourcePrefix":"/Docs","state":"approved","changedBy":"codex",` +
		`"createdAt":"2026-10-04T09:00:00Z","canRewind":false,"unavailableReason":"already-closed",` +
		`"files":{"added":[],"changed":[],"removed":[],"count":3}}` +
		`]}`})
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runUndo([]string{"--api", server.URL, "--home", home}); err != nil {
			t.Fatalf("runUndo: %v", err)
		}
	})
	if !strings.Contains(out, "nothing to undo") {
		t.Errorf("output = %q, want the nothing-to-undo line", out)
	}
	for _, call := range *requests {
		if call.Method == "POST" {
			t.Errorf("nothing was rewindable, so nothing may be posted; requests = %v", *requests)
		}
	}
}

func TestRunUndoReportsTheRoutesOwnSentenceForAnUnknownBranch(t *testing.T) {
	server, requests := undoServer(t, undoStandIn{})
	home := signedInHome(t)
	err := runUndo([]string{"--api", server.URL, "--home", home, "gone"})
	if err == nil || !strings.Contains(err.Error(), "There is no branch with that name.") {
		t.Fatalf("err = %v, want the route's own sentence", err)
	}
	for _, call := range *requests {
		if call.Method == "POST" {
			t.Errorf("a branch that does not exist must not be posted; requests = %v", *requests)
		}
	}
}

func TestRunUndoWaitsOutARewindThatIsStillRunning(t *testing.T) {
	sleepBranchJob = func(time.Duration) {}
	t.Cleanup(func() { sleepBranchJob = time.Sleep })
	server, requests := undoServer(t, undoStandIn{
		postState:  "rewinding",
		pollStates: []string{"rewinding", "discarded"},
	})
	home := signedInHome(t)
	out := captureStdout(t, func() {
		if err := runUndo([]string{"--api", server.URL, "--home", home, "new"}); err != nil {
			t.Fatalf("runUndo: %v", err)
		}
	})
	if !strings.Contains(out, `rewound codex's work in branch "new" (2 files removed; the original is untouched)`) {
		t.Errorf("output = %q", out)
	}
	gets := 0
	for _, call := range *requests {
		if call.Method == "GET" && call.Path == BRANCHES_PATH+"/new" {
			gets++
		}
	}
	if gets != 2 {
		t.Errorf("GET polls = %d, want 2; requests = %v", gets, *requests)
	}
}

func TestRunUndoRejectsASecondBranchName(t *testing.T) {
	err := runUndo([]string{"one", "two"})
	if err == nil || !strings.Contains(err.Error(), "usage: drive undo [branch]") {
		t.Fatalf("err = %v, want the usage line", err)
	}
}

func TestRunUndoNeedsASignedInDevice(t *testing.T) {
	home := t.TempDir()
	err := runUndo([]string{"--api", "https://api.example.invalid", "--home", home})
	if err == nil || !strings.Contains(err.Error(), "not signed in") {
		t.Fatalf("err = %v, want the not-signed-in sentence", err)
	}
}

func TestNewestRewindableIgnoresWhatCannotBeRewound(t *testing.T) {
	chosen, ok := newestRewindable([]RewindPreview{
		{Name: "newest-but-closed", CreatedAt: "2026-11-01T00:00:00Z"},
		{Name: "older", CreatedAt: "2026-09-01T00:00:00Z", CanRewind: true},
		{Name: "newer", CreatedAt: "2026-10-04T00:00:00Z", CanRewind: true},
	})
	if !ok || chosen.Name != "newer" {
		t.Fatalf("chosen = %q (%v), want \"newer\"", chosen.Name, ok)
	}
	if _, ok := newestRewindable(nil); ok {
		t.Fatal("no previews cannot be a pick")
	}
}
