package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// SHARE_PATH and REQUEST_PATH are the api Worker's owner endpoints (src/index.js routes these to src/share.js handleShareRequest and handleRequestRequest).
const (
	SHARE_PATH   = "/api/share"
	REQUEST_PATH = "/api/request"
)

const linkTimeout = 10 * time.Second

// ShareLink is the minted share as the CLI prints it (src/share.js `shareRow()`).
type ShareLink struct {
	Token        string `json:"token"`
	Path         string `json:"path"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	StateLabel   string `json:"stateLabel"`
	ExpiresAtIso string `json:"expiresAtIso"`
}

// RequestLink is the minted upload page (src/share.js `requestRow()`).
type RequestLink struct {
	Token        string `json:"token"`
	Folder       string `json:"folder"`
	Name         string `json:"name"`
	URL          string `json:"url"`
	StateLabel   string `json:"stateLabel"`
	ExpiresAtIso string `json:"expiresAtIso"`
	UploadsLabel string `json:"uploadsLabel"`
}

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
	return withFreshDeviceToken(common.home, l.api, os.Stdout, func(auth string) error {
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
		fmt.Printf("%s, %s\n", link.Path, untilLabel(link.ExpiresAtIso))
		return nil
	})
}

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
	return withFreshDeviceToken(common.home, l.api, os.Stdout, func(auth string) error {
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
		fmt.Printf("%s, %s\n", link.Folder, untilLabel(link.ExpiresAtIso))
		return nil
	})
}

func untilLabel(iso string) string {
	at, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	return "Until " + at.Local().Format("2 Jan")
}

func printShareLine(link ShareLink) {
	fmt.Printf("%s\t%s\t%s\t%s\t%s\n", link.Token, link.StateLabel, untilLabel(link.ExpiresAtIso), link.Path, link.URL)
}

func printRequestLine(link RequestLink) {
	fmt.Printf("%s\t%s\t%s\t%s\t%s\t%s\n", link.Token, link.StateLabel, untilLabel(link.ExpiresAtIso), link.Folder, link.UploadsLabel, link.URL)
}

var tokenRE = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func tokenFromArg(arg string) (string, error) {
	trimmed := strings.TrimSpace(arg)
	var token string
	if i := strings.Index(trimmed, "/s/"); i >= 0 {
		token = trimmed[i+len("/s/"):]
	} else if i := strings.Index(trimmed, "k="); i == 0 || (i > 0 && (trimmed[i-1] == '?' || trimmed[i-1] == '&')) {
		token = trimmed[i+len("k="):]
	} else {
		token = trimmed
	}
	if i := strings.IndexAny(token, "#?&"); i >= 0 {
		token = token[:i]
	}
	token = strings.TrimRight(token, "/")
	if !tokenRE.MatchString(token) {
		return "", fmt.Errorf("that is not a drive link token (22 letters, digits, - or _), got %q", arg)
	}
	return token, nil
}

// MintShare mints a share link for one file: POST /api/share {path}.
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

// RevokeShare turns a share off: DELETE /api/share {token}.
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
	if deviceToken != "" {
		request.Header.Set("authorization", "Bearer "+deviceToken)
	}
	request.Header.Set("user-agent", userAgent())
	client := newHTTPClient(linkTimeout)
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

func apiMessage(method, endpoint string, response *http.Response) error {
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if readErr != nil {
		return fmt.Errorf("%s %s: %s (unreadable answer: %v)", method, endpoint, response.Status, readErr)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return fmt.Errorf("%s %s: %s (unreadable answer: %v)", method, endpoint, response.Status, err)
	}
	if body.Error == "" {
		return &APIError{Method: method, Path: endpoint, Status: response.Status}
	}
	return &APIError{Method: method, Path: endpoint, Status: response.Status, Body: string(raw)}
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

func withFreshDeviceToken(home, api string, out io.Writer, call func(token string) error) error {
	creds, err := LoadCredentials(home)
	if err != nil {
		return err
	}
	base, err := resolveAPIBase(home, api)
	if err != nil {
		return err
	}
	err = call(creds.DeviceToken)
	if err == nil || !retryable401(err) {
		return err
	}
	token, _, signInErr := deviceReSigner{home: home, base: base, out: out}.ReSignIn()
	if signInErr != nil {
		return fmt.Errorf("%w (the token was also refused with %s)", signInErr, apiRefusedStatus(err))
	}
	return call(token)
}

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
