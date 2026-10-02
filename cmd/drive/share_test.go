package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// Tests for `drive share` and `drive request` (drive issue #19). Every test
// runs against a real httptest server that answers the api Worker's own
// endpoints (src/share.js handleShareRequest, handleRequestRequest), so the
// request the CLI sends and the row it prints are checked against the route's
// real contract rather than a hand-written fixture that can drift from it.

const shareToken = "AAAAAAAAAAAAAAAAAAAAAA"

// linkServer is a stand-in for the api Worker's two link endpoints. It records
// what was sent so a test can assert the method, the path and the body, and
// answers with the rows src/share.js returns.
type linkServer struct {
	calls     []linkCall
	shares    []ShareLink
	requests  []RequestLink
	mintErr   int
	revokeErr int
}

type linkCall struct {
	method string
	path   string
	body   string
}

func (s *linkServer) start(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body := new(strings.Builder)
		if r.Body != nil {
			buf := new(bytes.Buffer)
			if _, err := buf.ReadFrom(r.Body); err == nil {
				body.WriteString(buf.String())
			}
		}
		s.calls = append(s.calls, linkCall{method: r.Method, path: r.URL.Path, body: body.String()})
		w.Header().Set("content-type", "application/json")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == SHARE_PATH:
			if s.mintErr != 0 {
				w.WriteHeader(s.mintErr)
				_, _ = w.Write([]byte(`{"error":"That file is not here."}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "share": s.shares[0]})
		case r.Method == http.MethodGet && r.URL.Path == SHARE_PATH:
			_ = json.NewEncoder(w).Encode(map[string]any{"shares": s.shares})
		case r.Method == http.MethodDelete && r.URL.Path == SHARE_PATH:
			if s.revokeErr != 0 {
				w.WriteHeader(s.revokeErr)
				_, _ = w.Write([]byte(`{"error":"That link is not one of ours."}`))
				return
			}
			revoked := s.shares[0]
			revoked.StateLabel = "Revoked"
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "share": revoked})
		case r.Method == http.MethodPost && r.URL.Path == REQUEST_PATH:
			if s.mintErr != 0 {
				w.WriteHeader(s.mintErr)
				_, _ = w.Write([]byte(`{"error":"That folder is not here."}`))
				return
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "request": s.requests[0]})
		case r.Method == http.MethodGet && r.URL.Path == REQUEST_PATH:
			_ = json.NewEncoder(w).Encode(map[string]any{"requests": s.requests})
		case r.Method == http.MethodDelete && r.URL.Path == REQUEST_PATH:
			revoked := s.requests[0]
			revoked.StateLabel = "Revoked"
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "request": revoked})
		default:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"That link is not one of ours."}`))
		}
	}))
}

func testLinkServer() *linkServer {
	return &linkServer{
		shares: []ShareLink{{
			Token:        shareToken,
			Path:         "/Photos/cat.jpg",
			Name:         "cat.jpg",
			URL:          "https://drive.test/s/" + shareToken,
			StateLabel:   "Open",
			ExpiresLabel: "Until 7 Oct",
		}},
		requests: []RequestLink{{
			Token:        "BBBBBBBBBBBBBBBBBBBBBB",
			Folder:       "/Dropbox",
			Name:         "Dropbox",
			URL:          "https://drive.test/upload.html?k=BBBBBBBBBBBBBBBBBBBBBB",
			StateLabel:   "Open",
			ExpiresLabel: "Until 7 Oct",
		}},
	}
}

func TestMintSharePostsTheDrivePathAndPrintsTheWorkersLink(t *testing.T) {
	server := testLinkServer()
	srv := server.start(t)
	defer srv.Close()

	link, err := MintShare(srv.URL+SHARE_PATH, "/Photos/cat.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if link.URL != "https://drive.test/s/"+shareToken {
		t.Errorf("printed link %q, want the one the Worker returned", link.URL)
	}
	if len(server.calls) != 1 {
		t.Fatalf("got %d calls, want 1", len(server.calls))
	}
	call := server.calls[0]
	if call.method != http.MethodPost || call.path != SHARE_PATH {
		t.Errorf("sent %s %s, want POST %s", call.method, call.path, SHARE_PATH)
	}
	if !strings.Contains(call.body, `"/Photos/cat.jpg"`) {
		t.Errorf("body %q does not carry the path", call.body)
	}
}

func TestMintRequestPostsTheFolderAndPrintsTheUploadPage(t *testing.T) {
	server := testLinkServer()
	srv := server.start(t)
	defer srv.Close()

	link, err := MintRequest(srv.URL+REQUEST_PATH, "/Dropbox")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(link.URL, "upload.html?k=") {
		t.Errorf("printed page %q, want the upload page the Worker returned", link.URL)
	}
	call := server.calls[0]
	if call.method != http.MethodPost || call.path != REQUEST_PATH {
		t.Errorf("sent %s %s, want POST %s", call.method, call.path, REQUEST_PATH)
	}
	if !strings.Contains(call.body, `"/Dropbox"`) {
		t.Errorf("body %q does not carry the folder", call.body)
	}
}

func TestRevokeSendsTheTokenAndReportsTheWorkersState(t *testing.T) {
	server := testLinkServer()
	srv := server.start(t)
	defer srv.Close()

	link, err := RevokeShare(srv.URL+SHARE_PATH, shareToken)
	if err != nil {
		t.Fatal(err)
	}
	if link.StateLabel != "Revoked" {
		t.Errorf("state %q, want the Worker's Revoked", link.StateLabel)
	}
	call := server.calls[0]
	if call.method != http.MethodDelete || call.path != SHARE_PATH {
		t.Errorf("sent %s %s, want DELETE %s", call.method, call.path, SHARE_PATH)
	}
	if !strings.Contains(call.body, shareToken) {
		t.Errorf("body %q does not carry the token", call.body)
	}
}

func TestListReadsBothKinds(t *testing.T) {
	server := testLinkServer()
	srv := server.start(t)
	defer srv.Close()

	shares, err := ListShares(srv.URL + SHARE_PATH)
	if err != nil {
		t.Fatal(err)
	}
	if len(shares) != 1 || shares[0].Token != shareToken {
		t.Fatalf("shares %+v, want the one the Worker returned", shares)
	}
	requests, err := ListRequests(srv.URL + REQUEST_PATH)
	if err != nil {
		t.Fatal(err)
	}
	if len(requests) != 1 || requests[0].Folder != "/Dropbox" {
		t.Fatalf("requests %+v, want the one the Worker returned", requests)
	}
}

// A failed call carries the api Worker's own words, because that is the
// sentence a person needs ("That file is not here."), not a generic failure.
func TestAFailedCallCarriesTheWorkersMessage(t *testing.T) {
	server := testLinkServer()
	server.mintErr = http.StatusNotFound
	srv := server.start(t)
	defer srv.Close()

	_, err := MintShare(srv.URL+SHARE_PATH, "/Photos/cat.jpg")
	if err == nil {
		t.Fatal("minting a missing file succeeded")
	}
	if !strings.Contains(err.Error(), "That file is not here.") {
		t.Errorf("error %q does not carry the Worker's message", err)
	}
}

func TestAFailureWithNoReadableBodyIsStillNamed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html>bad gateway</html>"))
	}))
	defer srv.Close()

	_, err := MintShare(srv.URL+SHARE_PATH, "/Photos/cat.jpg")
	if err == nil {
		t.Fatal("a 502 mint succeeded")
	}
	if !strings.Contains(err.Error(), "502") {
		t.Errorf("error %q does not name the status", err)
	}
}

// A person holds a full link, not a token: the argument is reduced to the
// token the endpoint takes, for both link shapes, with a trailing slash or a
// query string after it. Anything that does not reduce to the Worker's token
// shape is refused here, not sent to the api.
func TestTokenFromArgAcceptsALinkOrAToken(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{shareToken, shareToken},
		{"  " + shareToken + "  ", shareToken},
		{"https://drive.test/s/" + shareToken, shareToken},
		{"https://drive.test/s/" + shareToken + "/", shareToken},
		{"https://drive.test/s/" + shareToken + "/?x=1", shareToken},
		{"https://drive.test/upload.html?k=" + shareToken, shareToken},
		{"https://drive.test/upload.html?k=" + shareToken + "&utm_source=mail", shareToken},
		// A URL fragment is not part of the token either.
		{"https://drive.test/s/" + shareToken + "#top", shareToken},
		{"https://drive.test/upload.html?k=" + shareToken + "#frag", shareToken},
	} {
		got, err := tokenFromArg(tc.in)
		if err != nil {
			t.Errorf("tokenFromArg(%q) failed: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("tokenFromArg(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestTokenFromArgRefusesAnythingNotTokenShaped(t *testing.T) {
	for _, in := range []string{
		"",
		"k=short",
		// The #205 example: the old extraction kept "/?x=1" as if it were
		// part of the token, and this paste reached RevokeShare/RevokeRequest.
		"https://drive.test/s/AAAAA/?x=1",
		"https://drive.test/s/AAAA/?x=1",
		// A "k=" inside a path segment is not the query parameter.
		"https://drive.test/disk=" + shareToken,
		"https://drive.test/k=evil",
		"../etc/passwd",
		"../" + shareToken,
	} {
		got, err := tokenFromArg(in)
		if err == nil {
			t.Errorf("tokenFromArg(%q) = %q, want an error", in, got)
			continue
		}
		// The refusal names the shape a person must paste, not a bare
		// "invalid".
		if !strings.Contains(err.Error(), "22") {
			t.Errorf("tokenFromArg(%q) error %q does not name the token shape", in, err)
		}
	}
}

// What a person types is a path inside the drive, with or without the mount
// dir in front; the endpoint always gets a slash-rooted drive path.
func TestDrivePathArgDropsTheMountDirAndKeepsASlashPath(t *testing.T) {
	home := t.TempDir()
	mountDir := DefaultMountDir(home)
	for _, tc := range []struct{ in, want string }{
		{"cat.jpg", "/cat.jpg"},
		{"/Photos/cat.jpg", "/Photos/cat.jpg"},
		{mountDir + "/Photos/cat.jpg", "/Photos/cat.jpg"},
		{mountDir, "/"},
		{"  /Photos/cat.jpg  ", "/Photos/cat.jpg"},
	} {
		got, err := drivePathArg(home, tc.in)
		if err != nil {
			t.Errorf("drivePathArg(%q): %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("drivePathArg(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDrivePathArgRefusesAPathThatLeavesTheDrive(t *testing.T) {
	home := t.TempDir()
	for _, in := range []string{"", "   ", "/../etc/passwd", "/Photos/../../etc", "/a//b"} {
		if got, err := drivePathArg(home, in); err == nil {
			t.Errorf("drivePathArg(%q) = %q, want an error", in, got)
		}
	}
}

// The command is asked for one job at a time, and asks for a name it can act
// on: no silent guess between mint, list and revoke.
func TestShareRefusesTwoJobsAndAMissingName(t *testing.T) {
	if err := runShare([]string{"--api", "https://drive.test", "--list", "--revoke", shareToken}); err == nil {
		t.Error("--list with --revoke was accepted")
	}
	if err := runShare([]string{"--api", "https://drive.test"}); err == nil {
		t.Error("share with no file was accepted")
	}
	if err := runShare([]string{"--api", "https://drive.test", "--list", "cat.jpg"}); err == nil {
		t.Error("--list with a file was accepted")
	}
	if err := runRequest([]string{"--api", "https://drive.test"}); err == nil {
		t.Error("request with no folder was accepted")
	}
}

func TestShareRefusesAnUnconfiguredApiWorker(t *testing.T) {
	t.Setenv("DRIVE_API_URL", "")
	home := t.TempDir()
	if err := runShare([]string{"--home", home, "cat.jpg"}); err == nil {
		t.Error("share with no api Worker URL was accepted")
	}
}

// The whole `drive share` path, run as the command itself: the argument is
// translated, the endpoint is called and the link reaches stdout.
func TestRunSharePrintsTheLink(t *testing.T) {
	server := testLinkServer()
	srv := server.start(t)
	defer srv.Close()
	home := t.TempDir()
	stdout := captureStdout(t, func() {
		if err := runShare([]string{"--api", srv.URL, "--home", home, filepath.Join(home, "Drive", "cat.jpg")}); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(stdout, "https://drive.test/s/"+shareToken) {
		t.Errorf("output %q does not carry the link", stdout)
	}
	if !strings.Contains(server.calls[0].body, `"/cat.jpg"`) {
		t.Errorf("body %q does not carry the drive path", server.calls[0].body)
	}
}

func TestRunRequestPrintsTheUploadPage(t *testing.T) {
	server := testLinkServer()
	srv := server.start(t)
	defer srv.Close()
	home := t.TempDir()
	stdout := captureStdout(t, func() {
		if err := runRequest([]string{"--api", srv.URL, "--home", home, "Dropbox"}); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(stdout, "upload.html?k=") {
		t.Errorf("output %q does not carry the upload page", stdout)
	}
	if !strings.Contains(server.calls[0].body, `"/Dropbox"`) {
		t.Errorf("body %q does not carry the folder", server.calls[0].body)
	}
}

func TestRunShareListSaysSoWhenThereAreNoLinks(t *testing.T) {
	server := &linkServer{}
	srv := server.start(t)
	defer srv.Close()
	home := t.TempDir()
	stdout := captureStdout(t, func() {
		if err := runShare([]string{"--api", srv.URL, "--home", home, "--list"}); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(stdout, "no share links") {
		t.Errorf("output %q does not say there are none", stdout)
	}
}

func TestRunShareRevokePrintsTheRevokedState(t *testing.T) {
	server := testLinkServer()
	srv := server.start(t)
	defer srv.Close()
	home := t.TempDir()
	stdout := captureStdout(t, func() {
		if err := runShare([]string{"--api", srv.URL, "--home", home, "--revoke", "https://drive.test/s/" + shareToken}); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(stdout, "Revoked") {
		t.Errorf("output %q does not carry the revoked state", stdout)
	}
	if !strings.Contains(server.calls[0].body, shareToken) {
		t.Errorf("body %q does not carry the token from the link", server.calls[0].body)
	}
}
