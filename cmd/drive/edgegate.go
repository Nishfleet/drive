package main

import (
	"net/http"
	"net/url"
	"os"
	"strings"
)

// A deployment that sits behind a Cloudflare Access gate (the private test
// site) answers the CLI with a login page, so device sign-in cannot start.
// An Access service token lets the CLI through: the two values below go out as
// CF-Access-Client-Id and CF-Access-Client-Secret, and only to the api host
// named by DRIVE_API_URL, never to the storage endpoint or any other host.
// Nothing is sent unless all three are set, so production behaves as before.
const (
	accessClientIDEnv     = "DRIVE_ACCESS_CLIENT_ID"
	accessClientSecretEnv = "DRIVE_ACCESS_CLIENT_SECRET"
)

type edgeGateTransport struct {
	next   http.RoundTripper
	host   string
	id     string
	secret string
}

func (t edgeGateTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL != nil && strings.EqualFold(r.URL.Host, t.host) {
		r = r.Clone(r.Context())
		r.Header.Set("CF-Access-Client-Id", t.id)
		r.Header.Set("CF-Access-Client-Secret", t.secret)
	}
	return t.next.RoundTrip(r)
}

// installEdgeGate wraps the default transport when a service token is
// configured. It is a no-op otherwise.
func installEdgeGate() {
	id := strings.TrimSpace(os.Getenv(accessClientIDEnv))
	secret := strings.TrimSpace(os.Getenv(accessClientSecretEnv))
	raw := strings.TrimSpace(os.Getenv("DRIVE_API_URL"))
	if id == "" || secret == "" || raw == "" {
		return
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return
	}
	http.DefaultTransport = edgeGateTransport{next: http.DefaultTransport, host: u.Host, id: id, secret: secret}
}
