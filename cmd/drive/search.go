package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// `drive search` (drive issue #18): find any file by name in under a second.
// The command is one HTTP GET against the api Worker's /api/search, which
// answers from the D1 file-name index and never lists the bucket; this file
// only renders what that endpoint already knows, so the words a person types
// are parsed once, in src/search.js.

// SEARCH_PATH is the api Worker's search endpoint (src/search.js
// SEARCH_ENDPOINT). One endpoint for the CLI and the agent tool, so both see
// the same index.
const SEARCH_PATH = "/api/search"

// searchTimeout bounds the query. A search is an interactive command; a
// request that hangs must not turn it into a hung terminal.
const searchTimeout = 10 * time.Second

// SearchHit is one file the index found. ModifiedAt is a pointer because the
// index stores null until the reconciler filled it in — an absent time is a
// real state, not a zero.
type SearchHit struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	SizeBytes  int64   `json:"sizeBytes"`
	ModifiedAt *string `json:"modifiedAt"`
}

// SearchResults is the shape GET /api/search returns (src/search.js
// `searchDrive`).
type SearchResults struct {
	Words     []string    `json:"words"`
	TookMs    float64     `json:"tookMs"`
	Count     int         `json:"count"`
	Truncated bool        `json:"truncated"`
	Results   []SearchHit `json:"results"`
	Error     string      `json:"error"`
}

// runSearch is `drive search <words>`: the query goes to the api Worker's
// index and the answer is printed one file a line. The endpoint and the
// account live in the Worker's config (--api / DRIVE_API_URL), so pointing
// the CLI at a different deployment needs no code change.
func runSearch(args []string) error {
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	limit := fs.Int("limit", 50, "how many results to print (1-200)")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	query := strings.Join(fs.Args(), " ")
	if strings.TrimSpace(query) == "" {
		fmt.Fprint(os.Stderr, usage)
		return errFlagParse
	}
	results, err := fetchSearch(*api, query, *limit)
	if err != nil {
		return err
	}
	printSearchResults(results)
	return nil
}

// fetchSearch runs the one GET and decodes the one answer shape. Every
// non-200 is a named error, never a quiet zero: 400 carries the Worker's own
// next step, 401 says the drive is not signed in on this machine, and a
// 5xx is passed through so an outage is not mistaken for "no matches".
func fetchSearch(apiBase, query string, limit int) (*SearchResults, error) {
	if strings.TrimSpace(apiBase) == "" {
		return nil, fmt.Errorf("no api Worker configured; set --api or DRIVE_API_URL")
	}
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return nil, err
	}
	params := url.Values{"q": []string{query}}
	if limit != 50 {
		params.Set("limit", fmt.Sprintf("%d", limit))
	}
	target := base + SEARCH_PATH + "?" + params.Encode()
	client := &http.Client{Timeout: searchTimeout}
	resp, err := client.Get(target)
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", target, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("GET %s: %w", target, err)
	}
	var results SearchResults
	if err := json.Unmarshal(body, &results); err != nil {
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("GET %s: %s", target, resp.Status)
		}
		return nil, fmt.Errorf("GET %s: the answer is not the search format: %w", target, err)
	}
	if resp.StatusCode != http.StatusOK {
		if results.Error != "" {
			return nil, fmt.Errorf("GET %s: %s", target, results.Error)
		}
		return nil, fmt.Errorf("GET %s: %s", target, resp.Status)
	}
	return &results, nil
}

// printSearchResults renders the answer: one line a file, the way Finder
// orders a folder listing, then a summary line that carries the time the
// index took — the number the issue's done-when is measured by.
func printSearchResults(r *SearchResults) {
	for _, hit := range r.Results {
		modified := "unknown time"
		if hit.ModifiedAt != nil && *hit.ModifiedAt != "" {
			modified = *hit.ModifiedAt
		}
		fmt.Printf("%s (%s, modified %s)\n", hit.Path, fileSize(hit.SizeBytes), modified)
	}
	headline := fmt.Sprintf("%d match%s for %q in %.0fms", r.Count, plural(r.Count), strings.Join(r.Words, " "), r.TookMs)
	if r.Truncated {
		headline += ", showing the first page"
	}
	fmt.Println(headline)
}

// fileSize renders a file size the way the usage page does (src/status.js
// formatBytes): one decimal under 10 KB, none above.
func fileSize(bytes int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB"}
	value := float64(bytes)
	unit := 0
	for value >= 1000 && unit < len(units)-1 {
		value /= 1000
		unit++
	}
	if unit == 0 {
		return fmt.Sprintf("%d B", bytes)
	}
	if value < 10 {
		return fmt.Sprintf("%.1f %s", value, units[unit])
	}
	return fmt.Sprintf("%.0f %s", value, units[unit])
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "es"
}
