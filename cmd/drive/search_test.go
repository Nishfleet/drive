package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// `drive search` against a stand-in api Worker: the same JSON src/search.js
// returns, served by net/http/httptest, so the command's parsing and its
// words are tested without a network.

func writeHits(t *testing.T, w http.ResponseWriter, body string) {
	t.Helper()
	w.Header().Set("content-type", "application/json; charset=utf-8")
	if _, err := w.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
}

const searchBody = `{
  "words": ["invoice"],
  "tookMs": 12.4,
  "count": 2,
  "truncated": false,
  "results": [
    {"path": "/fin/Invoice March.pdf", "name": "Invoice March.pdf", "sizeBytes": 2048, "modifiedAt": "2026-09-30T00:00:00.000Z"},
    {"path": "/fin/invoice-april.pdf", "name": "invoice-april.pdf", "sizeBytes": 128, "modifiedAt": null}
  ]
}`

func TestFetchSearchReadsTheIndexAnswer(t *testing.T) {
	var gotPath, gotQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.Query().Get("q")
		writeHits(t, w, searchBody)
	}))
	defer server.Close()

	results, err := fetchSearch(server.URL, "invoice", 50)
	if err != nil {
		t.Fatalf("fetchSearch: %v", err)
	}
	if gotPath != SEARCH_PATH {
		t.Errorf("path = %q, want %q", gotPath, SEARCH_PATH)
	}
	if gotQuery != "invoice" {
		t.Errorf("q = %q, want %q", gotQuery, "invoice")
	}
	if results.Count != 2 || len(results.Results) != 2 {
		t.Fatalf("count = %d, results = %d, want 2 and 2", results.Count, len(results.Results))
	}
	if results.Results[0].Path != "/fin/Invoice March.pdf" {
		t.Errorf("first path = %q", results.Results[0].Path)
	}
	if results.Results[1].ModifiedAt != nil {
		t.Errorf("a null modifiedAt must stay null, got %v", *results.Results[1].ModifiedAt)
	}
}

func TestFetchSearchPassesALimitOnlyWhenItIsNotTheDefault(t *testing.T) {
	for _, tc := range []struct {
		limit int
		want  string
	}{
		{50, ""},
		{10, "10"},
	} {
		var raw string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			raw = r.URL.RawQuery
			writeHits(t, w, searchBody)
		}))
		if _, err := fetchSearch(server.URL, "invoice", tc.limit); err != nil {
			t.Fatalf("limit %d: %v", tc.limit, err)
		}
		server.Close()
		if tc.want == "" && strings.Contains(raw, "limit=") {
			t.Errorf("limit %d sent %q; the default is the endpoint's own", tc.limit, raw)
		}
		if tc.want != "" && !strings.Contains(raw, "limit="+tc.want) {
			t.Errorf("limit %d sent %q, want limit=%s", tc.limit, raw, tc.want)
		}
	}
}

func TestFetchSearchNamesEveryFailure(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
		want   string
	}{
		{"anonymous", http.StatusUnauthorized, `{"error":"You are not signed in to your drive. Sign in, then this page updates on its own."}`, "not signed in"},
		{"empty query", http.StatusBadRequest, `{"error":"Type one or more words to search for."}`, "Type one or more words"},
		{"no index", http.StatusServiceUnavailable, `{"error":"The drive index is not configured on this deployment."}`, "not configured"},
		{"outage", http.StatusInternalServerError, `{"error":"boom"}`, "boom"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				writeHits(t, w, tc.body)
			}))
			defer server.Close()
			_, err := fetchSearch(server.URL, "invoice", 50)
			if err == nil {
				t.Fatalf("a %d must be an error, not an empty result", tc.status)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to name %q", err.Error(), tc.want)
			}
		})
	}
}

func TestFetchSearchRefusesABadAPIBase(t *testing.T) {
	for _, bad := range []string{
		"",
		"   ",
		"drive.example.com",
		"https://drive.example.com\nrm -rf /",
		"https://",
	} {
		if _, err := fetchSearch(bad, "invoice", 50); err == nil {
			t.Errorf("fetchSearch(%q) must fail, not search something", bad)
		}
	}
}

func TestPrintSearchResultsNamesTheTimeAndTruncation(t *testing.T) {
	fixed := "2026-09-30T00:00:00.000Z"
	results := &SearchResults{
		Words:     []string{"invoice"},
		TookMs:    12.4,
		Count:     51,
		Truncated: true,
		Results: []SearchHit{
			{Path: "/fin/Invoice March.pdf", SizeBytes: 2048, ModifiedAt: &fixed},
		},
	}
	out := captureStdout(t, func() { printSearchResults(results) })
	want := []string{
		"/fin/Invoice March.pdf (2.0 KB, modified 2026-09-30T00:00:00.000Z)",
		`51 matches for "invoice" in 12ms, showing the first page`,
	}
	for _, line := range want {
		if !strings.Contains(out, line) {
			t.Errorf("output %q missing %q", out, line)
		}
	}
}

func TestFileSizeReadsLikeThePage(t *testing.T) {
	for _, tc := range []struct {
		bytes int64
		want  string
	}{
		{0, "0 B"},
		{999, "999 B"},
		{1000, "1.0 KB"},
		{2048, "2.0 KB"},
		{128, "128 B"},
		{15_000_000, "15 MB"},
		{15_000_000_000, "15 GB"},
	} {
		if got := fileSize(tc.bytes); got != tc.want {
			t.Errorf("fileSize(%d) = %q, want %q", tc.bytes, got, tc.want)
		}
	}
}

func TestSearchResultsDecodeIgnoresUnknownFields(t *testing.T) {
	var results SearchResults
	if err := json.Unmarshal([]byte(`{"words":["a"],"tookMs":1,"count":0,"truncated":false,"results":[],"future":{"x":1}}`), &results); err != nil {
		t.Fatalf("an answer with a field this binary does not know must still decode: %v", err)
	}
}

func TestRunSearchReadsApiBaseDriveLoginSaved(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		writeHits(t, w, searchBody)
	}))
	defer server.Close()
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: "dtok"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRIVE_API_URL", "")
	if err := runSearch([]string{"--home", home, "invoice"}); err != nil {
		t.Fatal(err)
	}
	if gotPath != SEARCH_PATH {
		t.Errorf("path = %q, want the search route on the saved apiBase", gotPath)
	}
}
