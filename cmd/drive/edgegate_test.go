package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEdgeGateSendsTokenOnlyToTheAPIHost(t *testing.T) {
	var gotID, gotSecret string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotID, gotSecret = r.Header.Get("CF-Access-Client-Id"), r.Header.Get("CF-Access-Client-Secret")
	}))
	defer api.Close()
	var otherSeen string
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherSeen = r.Header.Get("CF-Access-Client-Id") + r.Header.Get("CF-Access-Client-Secret")
	}))
	defer other.Close()

	saved := http.DefaultTransport
	defer func() { http.DefaultTransport = saved }()
	t.Setenv("DRIVE_API_URL", api.URL)
	t.Setenv(accessClientIDEnv, "id-1")
	t.Setenv(accessClientSecretEnv, "secret-1")
	installEdgeGate()

	client := &http.Client{}
	for _, u := range []string{api.URL, other.URL} {
		resp, err := client.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	if gotID != "id-1" || gotSecret != "secret-1" {
		t.Fatalf("api host got id=%q secret=%q", gotID, gotSecret)
	}
	if otherSeen != "" {
		t.Fatalf("another host got the token: %q", otherSeen)
	}
}

func TestEdgeGateIsOffWithoutAFullToken(t *testing.T) {
	saved := http.DefaultTransport
	defer func() { http.DefaultTransport = saved }()
	t.Setenv("DRIVE_API_URL", "https://example.test")
	t.Setenv(accessClientIDEnv, "id-only")
	t.Setenv(accessClientSecretEnv, "")
	installEdgeGate()
	if http.DefaultTransport != saved {
		t.Fatal("transport was wrapped with a half token")
	}
}
