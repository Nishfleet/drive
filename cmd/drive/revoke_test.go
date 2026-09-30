package main

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// keyServer is a stand-in for the api Worker's key store (drive#2): it accepts
// the revoke request only when HTTP Basic auth carries the exact key pair, and
// answers 204 like the real endpoint will. It counts requests so tests can
// prove when a revoke was and was not attempted, and records whether the
// config file still existed at request time, which is the proof that the
// revoke runs before the local copy is deleted.
type keyServer struct {
	*APIKeyRevoker
	mu     sync.Mutex
	calls  int
	auth   string
	config bool // was RcloneConfigPath(home) still present at request time
}

func newKeyServer(t *testing.T, home, accessKeyID, secret string) *keyServer {
	t.Helper()
	ks := &keyServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ks.mu.Lock()
		ks.calls++
		ks.auth = r.Header.Get("Authorization")
		_, statErr := os.Stat(RcloneConfigPath(home))
		ks.config = statErr == nil
		ks.mu.Unlock()
		id, pass, ok := r.BasicAuth()
		if !ok || id != accessKeyID || pass != secret {
			http.Error(w, "unknown key", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != RevokePath {
			http.Error(w, "bad route", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	ks.APIKeyRevoker = &APIKeyRevoker{BaseURL: srv.URL}
	return ks
}

func (ks *keyServer) count() int {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	return ks.calls
}

func (ks *keyServer) sawConfigAtRequestTime() bool {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	return ks.config
}

func TestRevokeAuthenticatesWithTheKeyPairAndAnswersOK(t *testing.T) {
	ks := newKeyServer(t, t.TempDir(), "ACCESSKEYID", "SECRETACCESSKEY")
	if err := ks.Revoke(KeyPair{AccessKeyID: "ACCESSKEYID", SecretKey: "SECRETACCESSKEY"}); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if got := ks.count(); got != 1 {
		t.Fatalf("revoke attempts = %d, want 1", got)
	}
	const prefix = "Basic "
	if !strings.HasPrefix(ks.auth, prefix) {
		t.Fatalf("Authorization = %q, want Basic credentials", ks.auth)
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(ks.auth, prefix))
	if err != nil {
		t.Fatalf("decode Basic credentials: %v", err)
	}
	if got, want := string(raw), "ACCESSKEYID:SECRETACCESSKEY"; got != want {
		t.Errorf("Basic credentials = %q, want %q", got, want)
	}
}

func TestRevokeNamesANonOKAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no such route", http.StatusNotFound)
	}))
	defer srv.Close()
	err := (APIKeyRevoker{BaseURL: srv.URL}).Revoke(KeyPair{AccessKeyID: "A", SecretKey: "S"})
	if err == nil {
		t.Fatal("a 404 from the key endpoint must not pass for revoked")
	}
	if !strings.Contains(err.Error(), "404") {
		t.Errorf("error %q does not name the status", err)
	}
}

func TestRevokeNamesAnUnreachableServerWithoutPrintingTheKey(t *testing.T) {
	// Port 1 on loopback is reserved and refuses; no server of ours is there.
	r := APIKeyRevoker{BaseURL: "http://127.0.0.1:1"}
	err := r.Revoke(KeyPair{AccessKeyID: "ACCESSKEYID", SecretKey: "SECRETACCESSKEY"})
	if err == nil {
		t.Fatal("an unreachable key server must fail the revoke")
	}
	if !strings.Contains(err.Error(), RevokePath) {
		t.Errorf("error %q does not name the endpoint it tried", err)
	}
	if strings.Contains(err.Error(), "SECRETACCESSKEY") {
		t.Errorf("error %q carries the secret", err)
	}
}

func TestRevokeRejectsABadBaseURLBeforeAnyRequest(t *testing.T) {
	for _, base := range []string{"", "https://user:pass@example.com", "not a url"} {
		err := (APIKeyRevoker{BaseURL: base}).Revoke(KeyPair{AccessKeyID: "A", SecretKey: "S"})
		if err == nil {
			t.Errorf("base %q: want an error, got none", base)
		}
	}
}
