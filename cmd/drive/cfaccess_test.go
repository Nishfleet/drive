package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeAccess is a stand-in for an address behind Cloudflare Access: without
// the right cf-access-token it answers Access's sign-in redirect, with it the
// real answer. It also records each body it was sent.
func fakeAccess(t *testing.T, token string) (*httptest.Server, *[]string) {
	t.Helper()
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(accessTokenHeader) != token {
			w.Header().Set("Location", "https://drive-test.cloudflareaccess.com/cdn-cgi/access/login/x?redirect_url=%2F")
			w.WriteHeader(http.StatusFound)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(raw))
		w.Header().Set("content-type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	t.Cleanup(server.Close)
	return server, &bodies
}

// fakeCloudflared answers `access token` with the token once `access login`
// has run (or at once when signedIn is true) and counts both.
type fakeCloudflared struct {
	token    string
	signedIn bool
	tokens   atomic.Int32
	logins   atomic.Int32
	app      string
}

func (f *fakeCloudflared) install(t *accessTransport) {
	t.lookPath = func(string) (string, error) { return "/fake/cloudflared", nil }
	t.run = func(name string, args ...string) (string, error) {
		f.tokens.Add(1)
		if len(args) == 3 && args[0] == "access" && args[1] == "token" {
			f.app = strings.TrimPrefix(args[2], "-app=")
		}
		if !f.signedIn {
			return "Unable to find token for provided application.\n", errors.New("exit status 1")
		}
		return f.token + "\n", nil
	}
	t.login = func(name string, args ...string) error {
		f.logins.Add(1)
		f.signedIn = true
		return nil
	}
}

func TestAccessRedirectGetsATokenFromCloudflaredAndRetries(t *testing.T) {
	server, bodies := fakeAccess(t, "jwt.from.cloudflared")
	transport := newAccessTransport(http.DefaultTransport)
	fake := &fakeCloudflared{token: "jwt.from.cloudflared"}
	fake.install(transport)
	client := &APIClient{Base: server.URL, HTTP: &http.Client{Transport: transport}}

	var out map[string]any
	if err := client.post("/v1/device/code", map[string]string{"name": "mac"}, &out); err != nil {
		t.Fatalf("post behind Access: %v", err)
	}
	if out["ok"] != true {
		t.Fatalf("answer = %v", out)
	}
	if fake.logins.Load() != 1 {
		t.Fatalf("cloudflared access login ran %d times, want 1", fake.logins.Load())
	}
	if fake.app != server.URL {
		t.Fatalf("token asked for app %q, want %q", fake.app, server.URL)
	}
	if len(*bodies) != 1 || !strings.Contains((*bodies)[0], `"name":"mac"`) {
		t.Fatalf("the retry did not resend the body: %q", *bodies)
	}

	// The token is cached: the next call sends it at once, with no cloudflared.
	before := fake.tokens.Load()
	if err := client.post("/v1/device/code", map[string]string{"name": "mac"}, &out); err != nil {
		t.Fatalf("second post: %v", err)
	}
	if fake.tokens.Load() != before || fake.logins.Load() != 1 {
		t.Fatal("a cached token still ran cloudflared")
	}
}

func TestAccessUsesAnExistingCloudflaredTokenWithoutALogin(t *testing.T) {
	server, _ := fakeAccess(t, "already")
	transport := newAccessTransport(http.DefaultTransport)
	fake := &fakeCloudflared{token: "already", signedIn: true}
	fake.install(transport)
	client := &APIClient{Base: server.URL, HTTP: &http.Client{Transport: transport}}
	if err := client.post("/v1/device/code", map[string]string{}, nil); err != nil {
		t.Fatalf("post: %v", err)
	}
	if fake.logins.Load() != 0 {
		t.Fatal("a signed-in cloudflared was asked to log in again")
	}
}

func TestAccessWithoutCloudflaredSaysHowToInstallIt(t *testing.T) {
	server, _ := fakeAccess(t, "unused")
	transport := newAccessTransport(http.DefaultTransport)
	transport.lookPath = func(string) (string, error) { return "", errors.New("not found") }
	transport.run = func(string, ...string) (string, error) {
		t.Fatal("cloudflared ran although it is missing")
		return "", nil
	}
	client := &APIClient{Base: server.URL, HTTP: &http.Client{Transport: transport}}
	err := client.post("/v1/device/code", map[string]string{}, nil)
	var f *failure
	if !errors.As(err, &f) || f.Kind != "access-cloudflared-missing" {
		t.Fatalf("err = %v, want the access-cloudflared-missing failure", err)
	}
	if f.Next != "Install cloudflared: brew install cloudflared" {
		t.Fatalf("next step = %q", f.Next)
	}
}

func TestAccessLoginThatGivesNoTokenFails(t *testing.T) {
	server, _ := fakeAccess(t, "unused")
	transport := newAccessTransport(http.DefaultTransport)
	transport.lookPath = func(string) (string, error) { return "/fake/cloudflared", nil }
	transport.run = func(string, ...string) (string, error) { return "", errors.New("exit status 1") }
	transport.login = func(string, ...string) error { return nil }
	client := &APIClient{Base: server.URL, HTTP: &http.Client{Transport: transport}}
	err := client.post("/v1/device/code", map[string]string{}, nil)
	var f *failure
	if !errors.As(err, &f) || f.Kind != "access-login-failed" {
		t.Fatalf("err = %v, want access-login-failed", err)
	}
	if !strings.Contains(f.Next, "cloudflared access login "+server.URL) {
		t.Fatalf("next step does not name the address: %q", f.Next)
	}
}

func TestNoAccessRedirectNeverRunsCloudflared(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(accessTokenHeader) != "" {
			t.Errorf("an Access token was sent to a plain address")
		}
		if r.URL.Path == "/elsewhere" {
			http.Redirect(w, r, "/landed", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	transport := newAccessTransport(http.DefaultTransport)
	transport.lookPath = func(string) (string, error) {
		t.Fatal("cloudflared looked up for a plain address")
		return "", nil
	}
	client := &APIClient{Base: server.URL, HTTP: &http.Client{Transport: transport}}
	if err := client.post("/v1/device/code", map[string]string{}, nil); err != nil {
		t.Fatalf("post: %v", err)
	}
	// An ordinary redirect is followed as before, not taken for Access.
	resp, err := (&http.Client{Transport: transport}).Get(server.URL + "/elsewhere")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.Request.URL.Path != "/landed" {
		t.Fatalf("redirect not followed: %s", resp.Request.URL.Path)
	}
}

func TestIsAccessRedirect(t *testing.T) {
	cases := map[string]bool{
		"https://team.cloudflareaccess.com/cdn-cgi/access/login/x": true,
		"https://TEAM.CloudflareAccess.com/":                       true,
		"http://team.cloudflareaccess.com/":                        false,
		"https://cloudflareaccess.com.evil.example/":               false,
		"https://evilcloudflareaccess.com/":                        false,
		"/files":                                                   false,
	}
	for location, want := range cases {
		response := &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": {location}}}
		if got := isAccessRedirect(response); got != want {
			t.Errorf("%s: got %v, want %v", location, got, want)
		}
	}
	ok := &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Location": {"https://team.cloudflareaccess.com/"}}}
	if isAccessRedirect(ok) {
		t.Error("a 200 is not an Access redirect")
	}
}

func TestInstallAccessTransportOnce(t *testing.T) {
	saved := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = saved })
	installAccessTransport()
	first := http.DefaultTransport
	installAccessTransport()
	if http.DefaultTransport != first {
		t.Fatal("a second install wrapped the transport twice")
	}
	if _, ok := first.(*accessTransport); !ok {
		t.Fatal("the default transport is not the Access transport")
	}
}

func TestAccessTokenIsNeverSentToARedirectsOtherOrigin(t *testing.T) {
	var leaked atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(accessTokenHeader) != "" {
			leaked.Add(1)
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer other.Close()
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(accessTokenHeader) != "app.token" {
			w.Header().Set("Location", "https://drive-test.cloudflareaccess.com/cdn-cgi/access/login/x")
			w.WriteHeader(http.StatusFound)
			return
		}
		http.Redirect(w, r, other.URL+"/landed", http.StatusFound)
	}))
	defer app.Close()
	transport := newAccessTransport(http.DefaultTransport)
	fake := &fakeCloudflared{token: "app.token", signedIn: true}
	fake.install(transport)
	client := &http.Client{Transport: transport}
	for range 2 { // the second call uses the cached token from the start
		resp, err := client.Get(app.URL + "/start")
		if err != nil {
			t.Fatalf("get: %v", err)
		}
		resp.Body.Close()
		if resp.Request.URL.Host != strings.TrimPrefix(other.URL, "http://") {
			t.Fatalf("redirect not followed to the other origin: %s", resp.Request.URL)
		}
	}
	if leaked.Load() != 0 {
		t.Fatalf("the app's Access token reached another origin %d times", leaked.Load())
	}
}
