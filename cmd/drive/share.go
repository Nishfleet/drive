package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Share links and upload requests on the CLI side (drive issue #19,
// build-spec.md "Against Space": "Public file links and upload requests").
//
//   drive share <file>      a link anyone can open, logged out, for 7 days
//   drive request <folder>  a page anyone can drop files onto, into one folder
//
// Both are the owner's side of src/share.js. The api Worker mints the token
// (POST /api/share, POST /api/request), serves the bytes at /s/<token> and the
// upload page at upload.html?k=<token>, and refuses uploads while the account
// is read-only at its cap. Nothing here computes a URL, a token or an expiry:
// the CLI prints the URL the Worker returned, so the two surfaces cannot
// disagree about a link, exactly the way `drive status` prints the money
// /api/usage computed rather than working out its own.
//
// Revoking is part of the feature, not a nicety — "links expire after 7 days
// by default and can be revoked", and a revoked link is the 404 the issue's
// done-when names — so the same command takes --revoke, and --list is how a
// person finds the token of a link they minted yesterday, since the drive
// has no shares page yet.

// SHARE_PATH and REQUEST_PATH are the api Worker's owner endpoints
// (src/index.js routes these to src/share.js handleShareRequest and
// handleRequestRequest). Exported like USAGE_PATH so no second spelling of a
// route exists in the CLI.
const (
	SHARE_PATH   = "/api/share"
	REQUEST_PATH = "/api/request"
)

// linkTimeout bounds a mint, list or revoke. A link a person is waiting to
// copy is worth ten seconds; a hung request is not a link.
const linkTimeout = 10 * time.Second

// ShareLink is the minted share as the CLI prints it (src/share.js
// `shareRow()`). Only the fields this command shows are decoded: the Worker
// owns the rest.
type ShareLink struct {
	Token        string `json:"token"`
	Path         string `json:"path"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	StateLabel   string `json:"stateLabel"`
	ExpiresLabel string `json:"expiresLabel"`
}

// RequestLink is the minted upload page (src/share.js `requestRow()`).
type RequestLink struct {
	Token        string `json:"token"`
	Folder       string `json:"folder"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	StateLabel   string `json:"stateLabel"`
	ExpiresLabel string `json:"expiresLabel"`
}

// linkFlags are the flag shapes `drive share` and `drive request` share: one
// endpoint, three mutually exclusive jobs (mint, list, revoke).
type linkFlags struct {
	api    string
	revoke string
	list   bool
}

func addLinkFlags(fs *flag.FlagSet, action, argument string) *linkFlags {
	l := &linkFlags{}
	fs.StringVar(&l.api, "api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	fs.StringVar(&l.revoke, "revoke", "", "revoke the link with this token instead of minting one")
	fs.BoolVar(&l.list, "list", false, "list this account's links instead of minting one")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: drive %s [flags] <%s>\n\nflags:\n", action, argument)
		fs.PrintDefaults()
	}
	return l
}

// endpoint resolves the --api value into the endpoint for one job, and refuses
// the combinations that would make the command guess what it was asked to do.
func (l *linkFlags) endpoint(path string) (string, error) {
	if l.list && l.revoke != "" {
		return "", fmt.Errorf("--list and --revoke are two different jobs; pick one")
	}
	if strings.TrimSpace(l.api) == "" {
		return "", fmt.Errorf("no api Worker configured; set --api or DRIVE_API_URL")
	}
	base, err := parseAPIBase(l.api)
	if err != nil {
		return "", err
	}
	return base + path, nil
}

// runShare is `drive share`.
func runShare(args []string) error {
	fs := flag.NewFlagSet("share", flag.ContinueOnError)
	l := addLinkFlags(fs, "share", "file")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	endpoint, err := l.endpoint(SHARE_PATH)
	if err != nil {
		return err
	}
	switch {
	case l.list:
		if fs.NArg() > 0 {
			return fmt.Errorf("--list takes no file argument, got %q", fs.Arg(0))
		}
		links, err := ListShares(endpoint)
		if err != nil {
			return err
		}
		if len(links) == 0 {
			fmt.Println("no share links")
			return nil
		}
		for _, link := range links {
			printShareLine(link)
		}
		return nil
	case l.revoke != "":
		if fs.NArg() > 0 {
			return fmt.Errorf("--revoke takes no file argument, got %q", fs.Arg(0))
		}
		link, err := RevokeShare(endpoint, tokenFromArg(l.revoke))
		if err != nil {
			return err
		}
		fmt.Printf("revoked: %s (%s)\n", link.URL, link.StateLabel)
		return nil
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("name one file to share: drive share <file>")
	}
	path, err := drivePathArg(common.home, fs.Arg(0))
	if err != nil {
		return err
	}
	link, err := MintShare(endpoint, path)
	if err != nil {
		return err
	}
	fmt.Println(link.URL)
	fmt.Printf("%s, %s\n", link.Path, link.ExpiresLabel)
	return nil
}

// runRequest is `drive request`.
func runRequest(args []string) error {
	fs := flag.NewFlagSet("request", flag.ContinueOnError)
	l := addLinkFlags(fs, "request", "folder")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	endpoint, err := l.endpoint(REQUEST_PATH)
	if err != nil {
		return err
	}
	switch {
	case l.list:
		if fs.NArg() > 0 {
			return fmt.Errorf("--list takes no folder argument, got %q", fs.Arg(0))
		}
		links, err := ListRequests(endpoint)
		if err != nil {
			return err
		}
		if len(links) == 0 {
			fmt.Println("no upload requests")
			return nil
		}
		for _, link := range links {
			printRequestLine(link)
		}
		return nil
	case l.revoke != "":
		if fs.NArg() > 0 {
			return fmt.Errorf("--revoke takes no folder argument, got %q", fs.Arg(0))
		}
		link, err := RevokeRequest(endpoint, tokenFromArg(l.revoke))
		if err != nil {
			return err
		}
		fmt.Printf("revoked: %s (%s)\n", link.URL, link.StateLabel)
		return nil
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("name one folder to collect into: drive request <folder>")
	}
	folder, err := drivePathArg(common.home, fs.Arg(0))
	if err != nil {
		return err
	}
	link, err := MintRequest(endpoint, folder)
	if err != nil {
		return err
	}
	fmt.Println(link.URL)
	fmt.Printf("%s, %s\n", link.Folder, link.ExpiresLabel)
	return nil
}

// printShareLine is one row of `drive share --list`: the token a person needs
// for --revoke, the state, the expiry, and the link itself.
func printShareLine(link ShareLink) {
	fmt.Printf("%s\t%s\t%s\t%s\t%s\n", link.Token, link.StateLabel, link.ExpiresLabel, link.Path, link.URL)
}

func printRequestLine(link RequestLink) {
	fmt.Printf("%s\t%s\t%s\t%s\t%s\n", link.Token, link.StateLabel, link.ExpiresLabel, link.Folder, link.URL)
}

// tokenFromArg accepts what a person actually has in hand: the token, or the
// link it came in, because the link is what they copied.
func tokenFromArg(arg string) string {
	trimmed := strings.TrimSpace(arg)
	if i := strings.Index(trimmed, "/s/"); i >= 0 {
		return strings.TrimSuffix(trimmed[i+len("/s/"):], "/")
	}
	if i := strings.Index(trimmed, "k="); i >= 0 {
		return strings.TrimSuffix(trimmed[i+len("k="):], "/")
	}
	return trimmed
}

// MintShare mints a share link for one file: POST /api/share {path}. The
// Worker answers 201 with the share row (src/share.js handleShareRequest), and
// the row's URL is the link.
func MintShare(endpoint, path string) (ShareLink, error) {
	var out struct {
		Share ShareLink `json:"share"`
	}
	if err := postJSON(endpoint, map[string]string{"path": path}, &out); err != nil {
		return ShareLink{}, err
	}
	if out.Share.URL == "" {
		return ShareLink{}, fmt.Errorf("POST %s: the api Worker returned no link", endpoint)
	}
	return out.Share, nil
}

// MintRequest mints an upload page for one folder: POST /api/request {folder}.
func MintRequest(endpoint, folder string) (RequestLink, error) {
	var out struct {
		Request RequestLink `json:"request"`
	}
	if err := postJSON(endpoint, map[string]string{"folder": folder}, &out); err != nil {
		return RequestLink{}, err
	}
	if out.Request.URL == "" {
		return RequestLink{}, fmt.Errorf("POST %s: the api Worker returned no link", endpoint)
	}
	return out.Request, nil
}

// ListShares reads the account's links: GET /api/share.
func ListShares(endpoint string) ([]ShareLink, error) {
	var out struct {
		Shares []ShareLink `json:"shares"`
	}
	if err := getJSON(endpoint, &out); err != nil {
		return nil, err
	}
	return out.Shares, nil
}

// ListRequests reads the account's upload pages: GET /api/request.
func ListRequests(endpoint string) ([]RequestLink, error) {
	var out struct {
		Requests []RequestLink `json:"requests"`
	}
	if err := getJSON(endpoint, &out); err != nil {
		return nil, err
	}
	return out.Requests, nil
}

// RevokeShare turns a share off: DELETE /api/share {token}. The Worker's
// answer is the row in its revoked state, so the printed state is the
// Worker's, not this command's guess.
func RevokeShare(endpoint, token string) (ShareLink, error) {
	var out struct {
		Share ShareLink `json:"share"`
	}
	if err := deleteJSON(endpoint, map[string]string{"token": token}, &out); err != nil {
		return ShareLink{}, err
	}
	return out.Share, nil
}

// RevokeRequest turns an upload page off: DELETE /api/request {token}.
func RevokeRequest(endpoint, token string) (RequestLink, error) {
	var out struct {
		Request RequestLink `json:"request"`
	}
	if err := deleteJSON(endpoint, map[string]string{"token": token}, &out); err != nil {
		return RequestLink{}, err
	}
	return out.Request, nil
}

// doJSON sends one JSON request and decodes the JSON answer, turning every
// non-2xx into the api Worker's own message (src/index.js answers failures as
// {"error": "..."} with a status). The message is what a person should read,
// so it is carried through instead of replaced by a generic "request failed".
func doJSON(method, endpoint string, body any, out any) error {
	var reader *bytes.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("build the request: %w", err)
		}
		reader = bytes.NewReader(payload)
	} else {
		reader = bytes.NewReader(nil)
	}
	request, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, endpoint, err)
	}
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	client := &http.Client{Timeout: linkTimeout}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, endpoint, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return apiMessage(method, endpoint, response)
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(out); err != nil {
		return fmt.Errorf("%s %s: %w", method, endpoint, err)
	}
	return nil
}

// apiMessage turns a failed response into the error a person reads. The
// Worker's {"error": "..."} is preferred; a body without one (an asset 404, a
// proxy error page) is reported by status, and a body that cannot be read is
// itself reported rather than swallowed.
func apiMessage(method, endpoint string, response *http.Response) error {
	var body struct {
		Error string `json:"error"`
	}
	readErr := json.NewDecoder(response.Body).Decode(&body)
	if readErr == nil && body.Error != "" {
		return fmt.Errorf("%s %s: %s", method, endpoint, body.Error)
	}
	if readErr != nil {
		return fmt.Errorf("%s %s: %s (unreadable answer: %v)", method, endpoint, response.Status, readErr)
	}
	return fmt.Errorf("%s %s: %s", method, endpoint, response.Status)
}

func postJSON(endpoint string, body, out any) error {
	return doJSON(http.MethodPost, endpoint, body, out)
}

func getJSON(endpoint string, out any) error {
	return doJSON(http.MethodGet, endpoint, nil, out)
}

func deleteJSON(endpoint string, body, out any) error {
	return doJSON(http.MethodDelete, endpoint, body, out)
}

// drivePathArg turns what a person typed into the path the api Worker expects:
// a path inside the drive, starting with a slash (src/files.js validatePath).
// An absolute path under the mount dir is the copyable form a shell completion
// or a Finder drag gives (`~/Drive/Photos/cat.jpg`), so it is accepted and the
// mount dir is dropped; anything else keeps its own segments. The Worker is
// still the authority on whether the path exists and whether it may be shared.
func drivePathArg(home, arg string) (string, error) {
	trimmed := strings.TrimSpace(arg)
	if trimmed == "" {
		return "", fmt.Errorf("name a file or folder inside the drive")
	}
	if err := checkConfigValue("path", trimmed); err != nil {
		return "", err
	}
	mountDir := strings.TrimSuffix(DefaultMountDir(home), "/")
	if trimmed == mountDir {
		return "/", nil
	}
	if strings.HasPrefix(trimmed, mountDir+"/") {
		trimmed = strings.TrimPrefix(trimmed, mountDir)
	}
	if !strings.HasPrefix(trimmed, "/") {
		trimmed = "/" + trimmed
	}
	if trimmed != "/" {
		for _, segment := range strings.Split(strings.TrimPrefix(trimmed, "/"), "/") {
			if segment == "" || segment == "." || segment == ".." {
				return "", fmt.Errorf("path %q is not inside the drive", arg)
			}
		}
	}
	return trimmed, nil
}
