package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"regexp"
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
	UploadsLabel string `json:"uploadsLabel"`
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
func (l *linkFlags) endpoint(path, home string) (string, error) {
	if l.list && l.revoke != "" {
		return "", fmt.Errorf("--list and --revoke are two different jobs; pick one")
	}
	base, err := resolveAPIBase(home, l.api)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(base) == "" {
		return "", fail("no-api")
	}
	parsed, err := parseAPIBase(base)
	if err != nil {
		return "", failDetail("api-url", err)
	}
	return parsed + path, nil
}

// runShare is `drive share`.
func runShare(args []string) error {
	fs := flag.NewFlagSet("share", flag.ContinueOnError)
	l := addLinkFlags(fs, "share", "file")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	endpoint, err := l.endpoint(SHARE_PATH, common.home)
	if err != nil {
		return err
	}
	creds, err := LoadCredentials(common.home)
	if err != nil {
		return err
	}
	auth := creds.DeviceToken
	switch {
	case l.list:
		if fs.NArg() > 0 {
			return fmt.Errorf("--list takes no file argument, got %q", fs.Arg(0))
		}
		links, err := ListShares(endpoint, auth)
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
		token, err := tokenFromArg(l.revoke)
		if err != nil {
			return err
		}
		link, err := RevokeShare(endpoint, auth, token)
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
	link, err := MintShare(endpoint, auth, path)
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
	endpoint, err := l.endpoint(REQUEST_PATH, common.home)
	if err != nil {
		return err
	}
	creds, err := LoadCredentials(common.home)
	if err != nil {
		return err
	}
	auth := creds.DeviceToken
	switch {
	case l.list:
		if fs.NArg() > 0 {
			return fmt.Errorf("--list takes no folder argument, got %q", fs.Arg(0))
		}
		links, err := ListRequests(endpoint, auth)
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
		token, err := tokenFromArg(l.revoke)
		if err != nil {
			return err
		}
		link, err := RevokeRequest(endpoint, auth, token)
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
	link, err := MintRequest(endpoint, auth, folder)
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
	// No header row: `drive request --list` is one line per link, six
	// tab-separated fields, so a later header has to name them in this order.
	fmt.Printf("%s\t%s\t%s\t%s\t%s\t%s\n", link.Token, link.StateLabel, link.ExpiresLabel, link.Folder, link.UploadsLabel, link.URL)
}

// tokenRE is the one token shape the api Worker mints and accepts: 22
// base64url characters (src/share.js TOKEN_PATTERN). The CLI refuses anything
// else before it reaches the api, so junk from a mangled or hostile paste
// never becomes a lookup against the owner's account.
var tokenRE = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

// tokenFromArg accepts what a person actually has in hand: the token, or the
// link it came in, because the link is what they copied. A token is exactly 22
// base64url characters, so whatever follows it is surrounding junk to drop: a
// trailing slash, a query string, a fragment, or tracking parameters. The
// "k=" of the upload page is read only where a query puts it — at the start of
// the paste, or right after ? or & — so the "k=" of some path segment is never
// taken as the parameter. The result must be the Worker's shape or the CLI
// refuses it, so a mangled paste never becomes a revoke call.
func tokenFromArg(arg string) (string, error) {
	trimmed := strings.TrimSpace(arg)
	var token string
	if i := strings.Index(trimmed, "/s/"); i >= 0 {
		// The share-link form: a /s/<token> path segment.
		token = trimmed[i+len("/s/"):]
	} else if i := strings.Index(trimmed, "k="); i == 0 || (i > 0 && (trimmed[i-1] == '?' || trimmed[i-1] == '&')) {
		// The upload-page form: ?k=<token>, possibly among other params.
		// A bare "k=" (a clipboard that dropped the URL in front of it)
		// counts too.
		token = trimmed[i+len("k="):]
	} else {
		token = trimmed
	}
	// A token is exactly 22 base64url chars; anything after it — a trailing
	// slash, a query string, a fragment, or tracking params (?k=<token>&utm_
	// ...) — is surrounding junk to drop, not the token.
	if i := strings.IndexAny(token, "#?&"); i >= 0 {
		token = token[:i]
	}
	token = strings.TrimRight(token, "/")
	if !tokenRE.MatchString(token) {
		return "", fmt.Errorf("that is not a drive link token (22 letters, digits, - or _), got %q", arg)
	}
	return token, nil
}

// MintShare mints a share link for one file: POST /api/share {path}. The
// Worker answers 201 with the share row (src/share.js handleShareRequest), and
// the row's URL is the link.
func MintShare(endpoint, token, path string) (ShareLink, error) {
	var out struct {
		Share ShareLink `json:"share"`
	}
	if err := postJSON(endpoint, token, map[string]string{"path": path}, &out); err != nil {
		return ShareLink{}, err
	}
	if out.Share.URL == "" {
		return ShareLink{}, fmt.Errorf("POST %s: the api Worker returned no link", endpoint)
	}
	return out.Share, nil
}

// MintRequest mints an upload page for one folder: POST /api/request {folder}.
func MintRequest(endpoint, token, folder string) (RequestLink, error) {
	var out struct {
		Request RequestLink `json:"request"`
	}
	if err := postJSON(endpoint, token, map[string]string{"folder": folder}, &out); err != nil {
		return RequestLink{}, err
	}
	if out.Request.URL == "" {
		return RequestLink{}, fmt.Errorf("POST %s: the api Worker returned no link", endpoint)
	}
	return out.Request, nil
}

// ListShares reads the account's links: GET /api/share.
func ListShares(endpoint, token string) ([]ShareLink, error) {
	var out struct {
		Shares []ShareLink `json:"shares"`
	}
	if err := getJSON(endpoint, token, &out); err != nil {
		return nil, err
	}
	return out.Shares, nil
}

// ListRequests reads the account's upload pages: GET /api/request.
func ListRequests(endpoint, token string) ([]RequestLink, error) {
	var out struct {
		Requests []RequestLink `json:"requests"`
	}
	if err := getJSON(endpoint, token, &out); err != nil {
		return nil, err
	}
	return out.Requests, nil
}

// RevokeShare turns a share off: DELETE /api/share {token}. The Worker's
// answer is the row in its revoked state, so the printed state is the
// Worker's, not this command's guess.
func RevokeShare(endpoint, auth, token string) (ShareLink, error) {
	var out struct {
		Share ShareLink `json:"share"`
	}
	if err := deleteJSON(endpoint, auth, map[string]string{"token": token}, &out); err != nil {
		return ShareLink{}, err
	}
	return out.Share, nil
}

// RevokeRequest turns an upload page off: DELETE /api/request {token}.
func RevokeRequest(endpoint, auth, token string) (RequestLink, error) {
	var out struct {
		Request RequestLink `json:"request"`
	}
	if err := deleteJSON(endpoint, auth, map[string]string{"token": token}, &out); err != nil {
		return RequestLink{}, err
	}
	return out.Request, nil
}

// doJSON sends one JSON request and decodes the JSON answer, turning every
// non-2xx into the api Worker's own message (src/index.js answers failures as
// {"error": "..."} with a status). The message is what a person should read,
// so it is carried through instead of replaced by a generic "request failed".
func doJSON(method, endpoint, deviceToken string, body any, out any) error {
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
	// The links routes are behind the account gate, which takes this device's
	// token as a Bearer. Without it every call was the gate's 401.
	if deviceToken != "" {
		request.Header.Set("authorization", "Bearer "+deviceToken)
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

func postJSON(endpoint, token string, body, out any) error {
	return doJSON(http.MethodPost, endpoint, token, body, out)
}

func getJSON(endpoint, token string, out any) error {
	return doJSON(http.MethodGet, endpoint, token, nil, out)
}

func deleteJSON(endpoint, token string, body, out any) error {
	return doJSON(http.MethodDelete, endpoint, token, body, out)
}

// drivePathArg turns what a person typed into the path the api Worker expects:
// a path inside the drive, starting with a slash (core/files.js validatePath).
// An absolute path under the mount dir is the form a shell's ~ expansion or a
// Finder drag produces (`/Users/nish/Drive/Photos/cat.jpg`), so it is accepted
// and the mount dir is dropped; anything else keeps its own segments. A
// quoted `~/Drive/...` is never expanded here — the CLI does not guess a home
// from the argument — so it arrives as `/~/Drive/...`, names nothing, and the
// Worker's 404 says so. The Worker is still the authority on whether the path
// exists and whether it may be shared.
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
