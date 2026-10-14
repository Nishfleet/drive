package main

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

type keyServer struct {
	*APIKeyRevoker
	mu     sync.Mutex
	calls  int
	auth   string
	config bool
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

func TestRevokeReadsA401AsAnAlreadyDeadKey(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintln(w, `{"error":"This key was revoked or is not valid."}`)
	}))
	defer srv.Close()
	err := (APIKeyRevoker{BaseURL: srv.URL}).Revoke(KeyPair{AccessKeyID: "ACCESSKEYID", SecretKey: "SECRETACCESSKEY"})
	if err != nil {
		t.Fatalf("Revoke: %v", err)
	}
}

func TestRevokeAcceptsOnly204AndNeverRelaysTheResponse(t *testing.T) {
	for _, tc := range []struct {
		code        int
		wantRevoked bool
	}{
		{http.StatusNoContent, true},
		{http.StatusOK, false},
	} {
		name := fmt.Sprintf("code %d", tc.code)
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.code == http.StatusNoContent {
					w.WriteHeader(tc.code)
					return
				}
				w.Header().Set("Content-Type", "text/plain")
				w.WriteHeader(tc.code)
				fmt.Fprintln(w, "error: ACCESSKEYID SECRETACCESSKEY not found")
			}))
			defer srv.Close()
			err := (APIKeyRevoker{BaseURL: srv.URL}).Revoke(KeyPair{AccessKeyID: "ACCESSKEYID", SecretKey: "SECRETACCESSKEY"})
			if got := err == nil; got != tc.wantRevoked {
				t.Errorf("code %d: revoked = %v, want %v", tc.code, got, tc.wantRevoked)
			}
			if err != nil && strings.Contains(err.Error(), "SECRETACCESSKEY") {
				t.Errorf("error %q relays the response body", err)
			}
		})
	}
}

func TestRevokeDoesNotFollowARedirectWithTheCredential(t *testing.T) {
	const secret = "SECRETACCESSKEY"
	var gotAuth string
	var reached int
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer sink.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, sink.URL+RevokePath, http.StatusFound)
	}))
	defer redirector.Close()

	err := (APIKeyRevoker{BaseURL: redirector.URL}).Revoke(KeyPair{AccessKeyID: "ACCESSKEYID", SecretKey: secret})
	if err == nil {
		t.Fatal("a 302 is not 204, so the revoke must not read as done")
	}
	if reached != 0 {
		t.Errorf("the redirect was followed %d time(s); the credential must not travel to a redirect's target", reached)
	}
	if strings.Contains(gotAuth, secret) {
		t.Errorf("the sink received the credential: %q", gotAuth)
	}
}
