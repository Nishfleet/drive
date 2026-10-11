package api

import (
	"strings"
	"testing"
)

func TestParseBaseRefusesCredentialsAndCleartext(t *testing.T) {
	if _, err := ParseBase("https://user:pass@example.com"); err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("userinfo in URL = %v, want credentials refused", err)
	}
	if _, err := ParseBase("http://example.com"); err == nil || !strings.Contains(err.Error(), "https://") {
		t.Fatalf("remote http = %v, want https required", err)
	}
	got, err := ParseBase("http://127.0.0.1:8787/")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:8787" {
		t.Fatalf("loopback = %q, want trailing slash dropped", got)
	}
}

func TestNewAndParseBaseRefuseTheSameBrokenURLs(t *testing.T) {
	broken := []string{
		"https://drive.example\nGET /elsewhere",
		"https://drive.example\x00",
		"https://user:pass@example.com",
		"http://example.com",
	}
	for _, raw := range broken {
		_, parseErr := ParseBase(raw)
		_, newErr := New(raw, "")
		if parseErr == nil || newErr == nil {
			t.Errorf("%q: ParseBase=%v New=%v, want both refused", raw, parseErr, newErr)
		}
	}
}

func TestFailureKindSplitsRevokedFromRefused(t *testing.T) {
	if k := FailureKind(&Error{Status: "401 Unauthorized"}); k != "key-revoked" {
		t.Fatalf("401 kind = %q", k)
	}
	if k := FailureKind(&Error{Status: "500 Internal Server Error"}); k != "api-refused" {
		t.Fatalf("500 kind = %q", k)
	}
	if k := FailureKind(errTimeout{}); k != "offline" {
		t.Fatalf("plain error kind = %q", k)
	}
}

type errTimeout struct{}

func (errTimeout) Error() string { return "timeout" }
