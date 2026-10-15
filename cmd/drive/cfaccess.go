package main

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

const accessTokenHeader = "cf-access-token"

type accessTransport struct {
	base     http.RoundTripper
	lookPath func(file string) (string, error)
	run      func(name string, args ...string) (string, error)
	login    func(name string, args ...string) error

	mu     sync.Mutex
	tokens map[string]string
}

func newAccessTransport(base http.RoundTripper) *accessTransport {
	return &accessTransport{
		base:     base,
		lookPath: exec.LookPath,
		run: func(name string, args ...string) (string, error) {
			out, err := exec.Command(name, args...).Output()
			return string(out), err
		},
		login: func(name string, args ...string) error {
			cmd := exec.Command(name, args...)
			cmd.Stdin = os.Stdin
			cmd.Stdout = io.Discard
			cmd.Stderr = os.Stderr
			return cmd.Run()
		},
		tokens: map[string]string{},
	}
}

func installAccessTransport() {
	if _, already := http.DefaultTransport.(*accessTransport); already {
		return
	}
	http.DefaultTransport = newAccessTransport(http.DefaultTransport)
}

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

func appOrigin(u *url.URL) string {
	return u.Scheme + "://" + u.Host
}

// RoundTrip sends the request with a cached token when there is one.
func (t *accessTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	app := appOrigin(request.URL)
	var body []byte
	if request.Body != nil && request.GetBody == nil {
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

func (t *accessTransport) token(path, app string) string {
	out, err := t.run(path, "access", "token", "-app="+app)
	if err != nil {
		return ""
	}
	token := strings.TrimSpace(out)
	// cloudflared prints a sentence, not a token, when it has none.
	if token == "" || strings.ContainsAny(token, " \n\t") {
		return ""
	}
	return token
}
