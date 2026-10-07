package main

// Cloudflare Access on the api address (drive#342). Until drive has its own
// domain, the api is the site's workers.dev address, and every request to it
// passes Cloudflare Access first. A browser signs in there; the CLI cannot,
// so an unsigned request comes back as a redirect to <team>.cloudflareaccess.com.
//
// The stock tool for a CLI behind Access is cloudflared: `cloudflared access
// login <app>` signs in once in the browser and caches a token, and
// `cloudflared access token -app=<app>` prints it. The token goes on each
// request as the `cf-access-token` header, which Access accepts in place of
// its cookie. This file is that and nothing more: a RoundTripper installed as
// the process's default transport, so `drive init` and every api call (each
// builds its own http.Client with no transport of its own) get the header
// without each call site knowing about Access. On an address that is not
// behind Access nothing happens: no redirect, no cloudflared, no header.

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// accessTokenHeader is the header Cloudflare Access reads a CLI's token from.
const accessTokenHeader = "cf-access-token"

// accessTransport adds a Cloudflare Access token to requests for an app that
// asked for one. Tokens are cached per origin for the life of the process.
type accessTransport struct {
	base http.RoundTripper
	// lookPath and run are exec.LookPath and running a command; tests replace
	// them with fakes so no real cloudflared is needed.
	lookPath func(file string) (string, error)
	run      func(name string, args ...string) (string, error)
	login    func(name string, args ...string) error

	mu     sync.Mutex
	tokens map[string]string
}

// newAccessTransport wraps base with the Access token step.
func newAccessTransport(base http.RoundTripper) *accessTransport {
	return &accessTransport{
		base:     base,
		lookPath: exec.LookPath,
		run: func(name string, args ...string) (string, error) {
			out, err := exec.Command(name, args...).Output()
			return string(out), err
		},
		login: func(name string, args ...string) error {
			// The login opens the browser and prints the URL to open by hand,
			// so the person sees it; its stdout (the token) is not shown.
			cmd := exec.Command(name, args...)
			cmd.Stdin = os.Stdin
			cmd.Stdout = io.Discard
			cmd.Stderr = os.Stderr
			return cmd.Run()
		},
		tokens: map[string]string{},
	}
}

// installAccessTransport makes every default-transport client in this process
// Access-aware. Called once from main.
func installAccessTransport() {
	if _, already := http.DefaultTransport.(*accessTransport); already {
		return
	}
	http.DefaultTransport = newAccessTransport(http.DefaultTransport)
}

// isAccessRedirect reports whether an answer is Cloudflare Access sending an
// unsigned caller to its sign-in page.
func isAccessRedirect(response *http.Response) bool {
	if response.StatusCode < 300 || response.StatusCode > 399 {
		return false
	}
	location, err := url.Parse(response.Header.Get("Location"))
	if err != nil {
		return false
	}
	host := strings.ToLower(location.Hostname())
	return location.Scheme == "https" && strings.HasSuffix(host, ".cloudflareaccess.com")
}

// appOrigin is the Access application a request belongs to: its origin.
func appOrigin(u *url.URL) string {
	return u.Scheme + "://" + u.Host
}

// RoundTrip sends the request with a cached token when there is one. When
// Access answers with its sign-in redirect, it gets a token from cloudflared
// and sends the request once more with it.
func (t *accessTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	app := appOrigin(request.URL)
	var body []byte
	if request.Body != nil && request.GetBody == nil {
		// The body is read once so the retry can send it again.
		read, err := io.ReadAll(request.Body)
		request.Body.Close()
		if err != nil {
			return nil, err
		}
		body = read
		request = request.Clone(request.Context())
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	}
	first := t.withToken(request, t.cached(app))
	response, err := t.base.RoundTrip(first)
	if err != nil || !isAccessRedirect(response) {
		return response, err
	}
	response.Body.Close()
	token, ferr := t.fetchToken(app)
	if ferr != nil {
		return nil, ferr
	}
	retry := t.withToken(request, token)
	if request.GetBody != nil {
		fresh, gerr := request.GetBody()
		if gerr != nil {
			return nil, gerr
		}
		retry.Body = fresh
	}
	return t.base.RoundTrip(retry)
}

// withToken is a copy of the request carrying the token, or the request
// itself when there is no token.
func (t *accessTransport) withToken(request *http.Request, token string) *http.Request {
	if token == "" {
		return request
	}
	copied := request.Clone(request.Context())
	copied.Header.Set(accessTokenHeader, token)
	return copied
}

func (t *accessTransport) cached(app string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.tokens[app]
}

// fetchToken asks cloudflared for the app's token, signing in first when it
// has none cached. A missing cloudflared is the table's install step.
//
// The sign-in runs inside the caller's request, so a caller with a time limit
// (the api client's is 30 seconds) can run out while the browser is open. The
// token is still cached by cloudflared on disk, so the next command works;
// running `cloudflared access login <app>` once first avoids the wait.
func (t *accessTransport) fetchToken(app string) (string, error) {
	path, err := t.lookPath("cloudflared")
	if err != nil {
		return "", failDetail("access-cloudflared-missing", err)
	}
	token := t.token(path, app)
	if token == "" {
		if err := t.login(path, "access", "login", app); err != nil {
			return "", failDetail("access-login-failed", err, app)
		}
		token = t.token(path, app)
	}
	if token == "" {
		return "", failf("access-login-failed", app)
	}
	t.mu.Lock()
	t.tokens[app] = token
	t.mu.Unlock()
	return token, nil
}

// token is cloudflared's cached token for the app, or "" when it has none.
func (t *accessTransport) token(path, app string) string {
	out, err := t.run(path, "access", "token", "-app="+app)
	if err != nil {
		return ""
	}
	token := strings.TrimSpace(out)
	// cloudflared prints a sentence, not a token, when it has none; a JWT has
	// no spaces.
	if token == "" || strings.ContainsAny(token, " \n\t") {
		return ""
	}
	return token
}
