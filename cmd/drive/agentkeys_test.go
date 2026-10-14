package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeAPI struct {
	mu              sync.Mutex
	codes           map[string]DeviceCode
	approved        map[string]bool
	keys            map[string]MintedKey
	mintedKinds     []string
	mintedNames     []string
	deviceNames     []string
	revokedIDs      []string
	queueClears     []string
	renewedIDs      []string
	lastAuthHdr     string
	lastPath        string
	rejectMints     bool
	rejectRenews    bool
	renewBody       map[string]any
	deviceExpiresIn int
	keyKinds        map[string]string
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{
		codes:    map[string]DeviceCode{},
		approved: map[string]bool{},
		keys:     map[string]MintedKey{},
		keyKinds: map[string]string{},
	}
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastAuthHdr = r.Header.Get("authorization")
	f.lastPath = r.URL.Path
	switch {
	case r.URL.Path == deviceCodePath && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.deviceNames = append(f.deviceNames, body.Name)
		code := DeviceCode{
			DeviceCode:              "dev_secret",
			UserCode:                "BCDF-GHJK",
			VerificationURI:         "https://api.test/v1/device/approve",
			VerificationURIComplete: "https://api.test/v1/device/approve?user_code=BCDF-GHJK",
			ExpiresIn:               600,
			Interval:                1,
		}
		f.codes[code.UserCode] = code
		writeTestJSON(w, 200, code)
	case r.URL.Path == deviceTokenPath && r.Method == http.MethodPost:
		var body struct {
			DeviceCode string `json:"device_code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !f.approved[body.DeviceCode] {
			writeTestJSON(w, 200, map[string]any{"status": "pending"})
			return
		}
		writeTestJSON(w, 200, map[string]any{
			"status":      "approved",
			"deviceToken": testDeviceToken,
			"expiresAt":   testDeviceTokenExpiry,
			"account":     map[string]string{"id": "acct_1", "name": "Nish's MacBook", "email": "nish@example.com"},
		})
	case r.URL.Path == keysPath && r.Method == http.MethodPost:
		if f.rejectMints {
			writeTestJSON(w, 400, map[string]string{"error": "Unknown key kind: root."})
			return
		}
		var body struct {
			Kind string `json:"kind"`
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mintedKinds = append(f.mintedKinds, body.Kind)
		f.mintedNames = append(f.mintedNames, body.Name)
		var expiresAt *int64
		var expiresIn int
		if body.Kind == "agent" {
			at := time.Now().Add(agentKeyTTL).Unix()
			expiresAt = &at
		} else if body.Kind == "device" && f.deviceExpiresIn > 0 {
			at := time.Now().Add(time.Duration(f.deviceExpiresIn) * time.Second).Unix()
			expiresAt = &at
			expiresIn = f.deviceExpiresIn
		}
		keyID := "key_" + body.Name
		if _, exists := f.keys[keyID]; exists {
			keyID = fmt.Sprintf("key_%s_%d", body.Name, len(f.keys)+1)
		}
		key := MintedKey{
			KeyID:        keyID,
			AccessKeyID:  "ak_" + body.Name,
			Secret:       "sk_" + body.Name,
			Prefix:       "u/acct_1/",
			Capabilities: []string{"list", "read", "write"},
			ExpiresAt:    expiresAt,
			ExpiresIn:    expiresIn,
			Endpoint:     "http://127.0.0.1:39181",
			Bucket:       "drive-standin",
			Region:       "us-east-1",
			DownloadURL:  "https://dl.example.test/k/grant_" + body.Name + "/",
		}
		if expiresIn > 0 {
			key.SessionToken = "tok_" + body.Name
		}
		f.keys[key.KeyID] = key
		f.keyKinds[key.KeyID] = body.Kind
		writeTestJSON(w, 201, key)
	case strings.HasPrefix(r.URL.Path, keysPath+"/key_") && strings.HasSuffix(r.URL.Path, "/renew") && r.Method == http.MethodPost:
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, keysPath+"/"), "/renew")
		f.renewedIDs = append(f.renewedIDs, id)
		if f.rejectRenews {
			writeTestJSON(w, 409, map[string]string{"error": "That key is revoked."})
			return
		}
		key, ok := f.keys[id]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		at := time.Now().Add(agentKeyTTL + renewAnswerOffset).Unix()
		key.ExpiresAt = &at
		f.keys[id] = key
		if f.renewBody != nil {
			writeTestJSON(w, 200, f.renewBody)
			return
		}
		if f.keyKinds[id] == "device" {
			ttl := f.deviceExpiresIn
			if ttl <= 0 {
				ttl = int(agentKeyTTL.Seconds())
			}
			at := time.Now().Add(time.Duration(ttl) * time.Second).Unix()
			key.AccessKeyID = key.AccessKeyID + "_renewed"
			key.Secret = key.Secret + "_renewed"
			key.SessionToken = "tok_renewed"
			key.ExpiresAt = &at
			key.ExpiresIn = ttl
			f.keys[id] = key
			writeTestJSON(w, 200, map[string]any{
				"keyId":        key.KeyID,
				"name":         strings.TrimPrefix(id, "key_"),
				"kind":         "device",
				"prefix":       key.Prefix,
				"capabilities": key.Capabilities,
				"expiresAt":    at,
				"credential": map[string]any{
					"accessKeyId":  key.AccessKeyID,
					"secret":       key.Secret,
					"sessionToken": key.SessionToken,
					"expiresIn":    ttl,
					"expiresAt":    at,
				},
			})
			return
		}
		writeTestJSON(w, 200, map[string]any{
			"keyId":        key.KeyID,
			"name":         strings.TrimPrefix(id, "key_"),
			"kind":         "agent",
			"prefix":       key.Prefix,
			"capabilities": key.Capabilities,
			"expiresAt":    *key.ExpiresAt,
		})
	case strings.HasPrefix(r.URL.Path, keysPath+"/key_") && r.Method == http.MethodDelete:
		f.revokedIDs = append(f.revokedIDs, strings.TrimPrefix(r.URL.Path, keysPath+"/"))
		w.WriteHeader(http.StatusNoContent)
	case r.URL.Path == queueReportPath && r.Method == http.MethodDelete:
		f.queueClears = append(f.queueClears, r.Header.Get("authorization"))
		writeTestJSON(w, 200, map[string]any{"cleared": true})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

const testDeviceToken = "dtok_for_this_device"

const testDeviceTokenExpiry = int64(1_800_000_000)

func writeTestJSON(w http.ResponseWriter, status int, body any) {
	data, err := json.Marshal(body)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func TestSignInShowsTheCodeThenPollsUntilApproved(t *testing.T) {
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()

	client, err := NewAPIClient(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		api.mu.Lock()
		defer api.mu.Unlock()
		api.approved["dev_secret"] = true
	}()
	var out strings.Builder
	signed, err := SignIn(client, "Nish's MacBook", &out)
	if err != nil {
		t.Fatal(err)
	}
	if signed.Token != "dtok_for_this_device" {
		t.Fatalf("got token %q, want the one the Worker minted", signed.Token)
	}
	if signed.Account.ID != "acct_1" || signed.Account.Name != "Nish's MacBook" {
		t.Fatalf("got account %+v, want the one the Worker sent", signed.Account)
	}
	if signed.ExpiresAt != testDeviceTokenExpiry {
		t.Fatalf("got expiry %d, want the poll's expiresAt", signed.ExpiresAt)
	}
	printed := out.String()
	if !strings.Contains(printed, "BCDF-GHJK") {
		t.Errorf("the code was not shown on the terminal:\n%s", printed)
	}
	if !strings.Contains(printed, "https://api.test/v1/device/approve") {
		t.Errorf("the page to approve was not shown:\n%s", printed)
	}
}

func TestSignInFailsWithTheWorkersSentenceWhenACodeExpires(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case deviceCodePath:
			writeTestJSON(w, 200, DeviceCode{
				DeviceCode: "dev_secret", UserCode: "BCDF-GHJK",
				VerificationURI: "https://api.test/v1/device/approve", ExpiresIn: 600, Interval: 1,
			})
		default:
			writeTestJSON(w, 400, map[string]string{"error": "That device code has expired."})
		}
	}))
	defer server.Close()
	client, err := NewAPIClient(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	if _, err := SignIn(client, "laptop", &out); err == nil {
		t.Fatal("expected the expired code to fail")
	} else if !strings.Contains(err.Error(), "expired") {
		t.Fatalf("the Worker's own sentence was lost: %v", err)
	}
}

func TestA401TriggersOneReSignInAndTheCallThenSucceeds(t *testing.T) {
	home := t.TempDir()
	origOpen := openURL
	openURL = func(string) error { return nil }
	t.Cleanup(func() { openURL = origOpen })

	const dead = "dtok_expired"
	const fresh = "dtok_fresh"
	var mintCalls, codeCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == deviceCodePath && r.Method == http.MethodPost:
			codeCalls++
			writeTestJSON(w, 200, DeviceCode{
				DeviceCode: "dev_secret", UserCode: "BCDF-GHJK",
				VerificationURI: "https://api.test/v1/device/approve",
				ExpiresIn:       600, Interval: 1,
			})
		case r.URL.Path == deviceTokenPath && r.Method == http.MethodPost:
			writeTestJSON(w, 200, map[string]any{
				"status":      "approved",
				"deviceToken": fresh,
				"expiresAt":   testDeviceTokenExpiry,
				"account":     map[string]string{"id": "acct_1", "name": "Nish", "email": "nish@example.com"},
			})
		case r.URL.Path == keysPath && r.Method == http.MethodPost:
			mintCalls++
			auth := r.Header.Get("authorization")
			if auth == "Bearer "+dead {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if auth != "Bearer "+fresh {
				http.Error(w, "bad token "+auth, http.StatusBadRequest)
				return
			}
			writeTestJSON(w, 200, MintedKey{
				KeyID: "key_device", AccessKeyID: "ak", Secret: "sk",
				Prefix: "u/acct_1/", Capabilities: []string{"list", "read", "write"},
				Endpoint: "http://127.0.0.1:9", Bucket: "drive-standin", Region: "us-east-1",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: dead}); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	client, err := signedInClient(home, "", &out)
	if err != nil {
		t.Fatal(err)
	}
	key, err := client.MintKey("device", "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if key.KeyID != "key_device" {
		t.Fatalf("got %+v after the re-sign-in", key)
	}
	if mintCalls != 2 {
		t.Fatalf("mint ran %d times, want 2 (one 401, then the retry)", mintCalls)
	}
	if codeCalls != 1 {
		t.Fatalf("device flow ran %d times, want 1", codeCalls)
	}
	if !strings.Contains(out.String(), reSignInLine) {
		t.Errorf("did not print the one re-sign-in line:\n%s", out.String())
	}
	creds, err := LoadCredentials(home)
	if err != nil {
		t.Fatal(err)
	}
	if creds.DeviceToken != fresh {
		t.Fatalf("stored token %q, want the one the re-sign-in wrote", creds.DeviceToken)
	}
}

func TestShareLinksReSignInOnceOnA401(t *testing.T) {
	home := t.TempDir()
	origOpen := openURL
	openURL = func(string) error { return nil }
	t.Cleanup(func() { openURL = origOpen })

	const dead = "dtok_expired"
	const fresh = "dtok_fresh"
	var codeCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == deviceCodePath && r.Method == http.MethodPost:
			codeCalls++
			writeTestJSON(w, 200, DeviceCode{
				DeviceCode: "dev_secret", UserCode: "BCDF-GHJK",
				VerificationURI: "https://api.test/v1/device/approve",
				ExpiresIn:       600, Interval: 1,
			})
		case r.URL.Path == deviceTokenPath && r.Method == http.MethodPost:
			writeTestJSON(w, 200, map[string]any{
				"status":      "approved",
				"deviceToken": fresh,
				"expiresAt":   testDeviceTokenExpiry,
				"account":     map[string]string{"id": "acct_1", "name": "Nish", "email": "nish@example.com"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: dead}); err != nil {
		t.Fatal(err)
	}

	var tokens []string
	var out strings.Builder
	err := withFreshDeviceToken(home, "", &out, func(token string) error {
		tokens = append(tokens, token)
		if token == dead {
			return &APIError{Method: http.MethodPost, Path: "/api/links", Status: "401 Unauthorized"}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tokens) != 2 || tokens[0] != dead || tokens[1] != fresh {
		t.Fatalf("calls ran with %v, want the dead token then the fresh one", tokens)
	}
	if codeCalls != 1 {
		t.Fatalf("device flow ran %d times, want 1", codeCalls)
	}

	tokens = nil
	err = withFreshDeviceToken(home, "", &out, func(token string) error {
		tokens = append(tokens, token)
		return &APIError{Method: http.MethodPost, Path: "/api/links", Status: "403 Forbidden"}
	})
	if err == nil || len(tokens) != 1 || codeCalls != 1 {
		t.Fatalf("a 403 retried or re-signed in: err=%v calls=%v deviceFlows=%d", err, tokens, codeCalls)
	}
}

func TestMintAndRevokeUseTheWorkersRoutesAndTheBearerToken(t *testing.T) {
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, err := NewAPIClient(server.URL, testDeviceToken)
	if err != nil {
		t.Fatal(err)
	}
	key, err := client.MintKey("agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	if key.KeyID != "key_claude" || key.Secret == "" {
		t.Fatalf("unexpected key: %+v", key)
	}
	if api.lastAuthHdr != "Bearer "+testDeviceToken {
		t.Errorf("mint sent authorization %q, want the device token", api.lastAuthHdr)
	}
	if len(api.mintedKinds) != 1 || api.mintedKinds[0] != "agent" || api.mintedNames[0] != "claude" {
		t.Errorf("mint sent kind/name %v/%v, want agent/claude", api.mintedKinds, api.mintedNames)
	}
	if err := client.RevokeKey(key.KeyID); err != nil {
		t.Fatal(err)
	}
	if len(api.revokedIDs) != 1 || api.revokedIDs[0] != "key_claude" {
		t.Errorf("revoke sent %v, want key_claude", api.revokedIDs)
	}
}

func TestAMintedKeyCarriesNoDeleteFiles(t *testing.T) {
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, _ := NewAPIClient(server.URL, "dtok")
	key, err := client.MintKey("agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range key.Capabilities {
		if c == "delete" {
			t.Fatalf("an agent key came back with delete: %v", key.Capabilities)
		}
	}
}

func TestAWorkersRefusalIsTheSentenceAPersonReads(t *testing.T) {
	api := newFakeAPI()
	api.rejectMints = true
	server := httptest.NewServer(api)
	defer server.Close()
	client, _ := NewAPIClient(server.URL, "dtok")
	_, err := client.MintKey("root", "claude")
	if err == nil {
		t.Fatal("expected the refused mint to fail")
	}
	if !strings.Contains(err.Error(), "The drive's api refused the request.") {
		t.Fatalf("the table words were lost: %v", err)
	}
	if !strings.Contains(err.Error(), "Unknown key kind") {
		t.Fatalf("the Worker's own sentence was lost: %v", err)
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || !strings.Contains(apiErr.Status, "400") {
		t.Fatalf("the refusal's status is not in the error chain: %v", err)
	}
}

func TestCredentialsRoundTripAtMode0600(t *testing.T) {
	home := t.TempDir()
	creds := Credentials{APIBase: "https://api.drive.test", DeviceToken: "dtok_secret", AccountID: "acct_1"}
	if err := SaveCredentials(home, creds); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(CredentialsPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credentials are mode %o, want 600", info.Mode().Perm())
	}
	loaded, err := LoadCredentials(home)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.DeviceToken != "dtok_secret" {
		t.Fatalf("read back %+v", loaded)
	}
}

func TestAgentKeysAreOneFilePerDeviceAndKeepEveryTool(t *testing.T) {
	home := t.TempDir()
	if keys, err := loadAgentKeys(home); err != nil || len(keys) != 0 {
		t.Fatalf("a fresh device should hold no keys, got %v (%v)", keys, err)
	}
	if err := saveAgentKey(home, "claude", MintedKey{KeyID: "key_claude", AccessKeyID: "ak_claude", Secret: "sk_claude", Prefix: "u/a1/"}); err != nil {
		t.Fatal(err)
	}
	if err := saveAgentKey(home, "codex", MintedKey{KeyID: "key_codex", AccessKeyID: "ak_codex", Secret: "sk_codex", Prefix: "u/a1/"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(AgentKeysPath(home))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("agent keys are mode %o, want 600", info.Mode().Perm())
	}
	claude, err := agentKeyFor(home, "claude")
	if err != nil || claude == nil {
		t.Fatalf("claude's key is gone: %v (%v)", claude, err)
	}
	if claude.AccessKeyID != "ak_claude" {
		t.Fatalf("claude has %q", claude.AccessKeyID)
	}
	if err := removeAgentKey(home, "claude"); err != nil {
		t.Fatal(err)
	}
	if gone, _ := agentKeyFor(home, "claude"); gone != nil {
		t.Fatal("claude's key survived a revoke")
	}
	if codex, _ := agentKeyFor(home, "codex"); codex == nil || codex.AccessKeyID != "ak_codex" {
		t.Fatal("revoking claude took codex's key with it")
	}
	if _, err := os.Stat(filepath.Dir(AgentKeysPath(home))); err != nil {
		t.Fatalf("the config dir should survive: %v", err)
	}
}

func TestAConnectedToolGetsItsOwnKeyInItsMCPEntry(t *testing.T) {
	home := t.TempDir()
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, err := NewAPIClient(server.URL, "dtok")
	if err != nil {
		t.Fatal(err)
	}
	env := Env{Home: home, Minter: ToolMinter{Client: client, Home: home}}.withDefaults()
	for _, name := range []string{"cursor", "kiro"} {
		tool, err := toolByName(name)
		if err != nil {
			t.Fatal(err)
		}
		if err := mintToolKey(env, tool); err != nil {
			t.Fatal(err)
		}
		if err := tool.Connect(env); err != nil {
			t.Fatal(err)
		}
	}
	if len(api.mintedNames) != 2 || api.mintedNames[0] != "cursor" || api.mintedNames[1] != "kiro" {
		t.Fatalf("minted %v, want one key each for cursor and kiro", api.mintedNames)
	}
	cursor, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := cursor.readConfig(env)
	if err != nil {
		t.Fatal(err)
	}
	cursorEntry, _ := serverTable(doc, false)
	entry, _ := cursorEntry[serverName].(map[string]any)
	envVars, _ := entry["env"].(map[string]any)
	if envVars["DRIVE_ACCESS_KEY_ID"] != "ak_cursor" {
		t.Fatalf("cursor's entry has no key of its own: %v", entry)
	}
	if envVars["DRIVE_SECRET_ACCESS_KEY"] != "sk_cursor" {
		t.Fatalf("cursor's entry has no secret of its own: %v", entry)
	}
	kiro, _ := toolByName("kiro")
	kiroDoc, err := kiro.readConfig(env)
	if err != nil {
		t.Fatal(err)
	}
	kiroTable, _ := serverTable(kiroDoc, false)
	kiroEntry, _ := kiroTable[serverName].(map[string]any)
	kiroVars, _ := kiroEntry["env"].(map[string]any)
	if kiroVars["DRIVE_ACCESS_KEY_ID"] != "ak_kiro" {
		t.Fatalf("kiro's entry is not its own key: %v", kiroEntry)
	}
}

func TestRevokingAToolTakesOnlyThatToolsKey(t *testing.T) {
	home := t.TempDir()
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, _ := NewAPIClient(server.URL, "dtok")
	env := Env{Home: home, Minter: ToolMinter{Client: client, Home: home}}.withDefaults()
	for _, name := range []string{"cursor", "kiro"} {
		tool, _ := toolByName(name)
		if err := mintToolKey(env, tool); err != nil {
			t.Fatal(err)
		}
	}
	cursor, _ := toolByName("cursor")
	if err := cursor.Revoke(env); err != nil {
		t.Fatal(err)
	}
	if len(api.revokedIDs) != 0 {
		t.Fatal("a local disconnect alone must not claim a server-side revoke")
	}
	key, err := agentKeyFor(home, "cursor")
	if err != nil || key == nil {
		t.Fatalf("cursor has no key to revoke: %v (%v)", key, err)
	}
	if err := env.Minter.RevokeKey(key.KeyID); err != nil {
		t.Fatal(err)
	}
	if len(api.revokedIDs) != 1 || api.revokedIDs[0] != "key_cursor" {
		t.Fatalf("revoked %v, want key_cursor", api.revokedIDs)
	}
	if codex, _ := agentKeyFor(home, "kiro"); codex == nil {
		t.Fatal("revoking cursor took kiro's key")
	}
}

func TestAConnectedToolKeepsTheExistingKeyOnASecondRun(t *testing.T) {
	home := t.TempDir()
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, _ := NewAPIClient(server.URL, "dtok")
	env := Env{Home: home, Minter: ToolMinter{Client: client, Home: home}}.withDefaults()
	cursor, _ := toolByName("cursor")
	for i := 0; i < 2; i++ {
		if err := mintToolKey(env, cursor); err != nil {
			t.Fatal(err)
		}
	}
	if len(api.mintedNames) != 1 {
		t.Fatalf("minted %v, want exactly one key across two runs", api.mintedNames)
	}
}

const renewAnswerOffset = agentKeyTTL / 2

func TestAnAgentKeyCarriesItsExpiryAndADeviceKeyDoesNot(t *testing.T) {
	home := t.TempDir()
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, err := NewAPIClient(server.URL, "dtok")
	if err != nil {
		t.Fatal(err)
	}
	env := Env{Home: home, Minter: ToolMinter{Client: client, Home: home}}.withDefaults()

	agent, err := env.Minter.MintKey("agent", "claude")
	if err != nil {
		t.Fatal(err)
	}
	if agent.ExpiresAt == nil {
		t.Fatal("an agent key must carry the hour it was minted with")
	}
	stored, err := agentKeyFor(home, "claude")
	if err != nil || stored == nil {
		t.Fatalf("claude's key is gone: %v (%v)", stored, err)
	}
	if stored.ExpiresAt == nil || *stored.ExpiresAt != *agent.ExpiresAt {
		t.Fatalf("the stored key's expiry is %v, want %v", stored.ExpiresAt, agent.ExpiresAt)
	}
	device, err := env.Minter.MintKey("device", "laptop")
	if err != nil {
		t.Fatal(err)
	}
	if device.ExpiresAt != nil {
		t.Fatalf("a person's own device key was given an expiry: %v", *device.ExpiresAt)
	}
}

func TestExpiryLabelNamesTheInstantOrTheAbsenceOfOne(t *testing.T) {
	at := time.Date(2026, 10, 2, 13, 4, 0, 0, time.UTC)
	seconds := at.Unix()
	want := "expires " + at.Local().Format("2006-01-02 15:04")
	if got := expiryLabel(nil); got != "renews while this tool uses it" {
		t.Fatalf("a key with no expiry reads %q", got)
	}
	if got := expiryLabel(&seconds); got != want {
		t.Fatalf("an expiry reads %q, want %q", got, want)
	}
}

func TestInitShowsTheExpiryTheToolHolds(t *testing.T) {
	stubAgentPath(t)
	home := t.TempDir()
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, _ := NewAPIClient(server.URL, "dtok")
	env := Env{
		Home:     home,
		Runner:   &recordingRunner{},
		LookPath: func(name string) (string, error) { return "/fake/" + name, nil },
		Minter:   ToolMinter{Client: client, Home: home},
	}.withDefaults()
	if err := initAgents(env); err != nil {
		t.Fatal(err)
	}
	key, err := agentKeyFor(home, "cursor")
	if err != nil || key == nil {
		t.Fatalf("cursor has no key: %v (%v)", key, err)
	}
	if key.ExpiresAt == nil {
		t.Fatal("a key minted with the hour must carry it")
	}

	key.ExpiresAt = nil
	if err := saveAgentKey(home, "cursor", MintedKey(*key)); err != nil {
		t.Fatal(err)
	}
	legacy := captureStdout(t, func() {
		if err := initAgents(env); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(legacy, "renews while this tool uses it") {
		t.Fatalf("the connected line does not say what renews the key:\n%s", legacy)
	}
	if len(api.renewedIDs) != 0 {
		t.Fatalf("renewed %v, want no renewal for a key with no expiry on disk", api.renewedIDs)
	}

	almost := time.Now().Add(time.Minute).Unix()
	key.ExpiresAt = &almost
	if err := saveAgentKey(home, "cursor", MintedKey(*key)); err != nil {
		t.Fatal(err)
	}
	if err := initAgents(env); err != nil {
		t.Fatal(err)
	}
	answered := api.keys["key_cursor"].ExpiresAt
	if answered == nil {
		t.Fatal("the fake Worker sent no expiry with the renewal")
	}
	want := "expires " + time.Unix(*answered, 0).Local().Format("2006-01-02 15:04")
	renewed := captureStdout(t, func() {
		if err := initAgents(env); err != nil {
			t.Fatal(err)
		}
	})
	if !strings.Contains(renewed, want) {
		t.Fatalf("the connected line must carry %q:\n%s", want, renewed)
	}
	if strings.Contains(renewed, "renews while this tool uses it") {
		t.Fatalf("a key with an hour reads as though it has none:\n%s", renewed)
	}
}

func TestNeedsRenewOnlyForAKeyInsideTheMargin(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	soon := now.Add(time.Minute).Unix()
	later := now.Add(agentKeyTTL).Unix()
	past := now.Add(-time.Minute).Unix()
	for _, tc := range []struct {
		name string
		key  *agentKey
		want bool
	}{
		{"no key at all", nil, false},
		{"no expiry", &agentKey{ExpiresAt: nil}, false},
		{"an hour left", &agentKey{ExpiresAt: &later}, false},
		{"a minute left", &agentKey{ExpiresAt: &soon}, true},
		{"already past", &agentKey{ExpiresAt: &past}, true},
	} {
		if got := needsRenew(tc.key, now); got != tc.want {
			t.Errorf("%s: needsRenew = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestAnIdleToolsKeyIsRenewedAndOneWithTimeLeftIsNot(t *testing.T) {
	home := t.TempDir()
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()
	client, _ := NewAPIClient(server.URL, "dtok")
	env := Env{Home: home, Minter: ToolMinter{Client: client, Home: home}}.withDefaults()
	cursor, _ := toolByName("cursor")
	if err := mintToolKey(env, cursor); err != nil {
		t.Fatal(err)
	}
	if err := mintToolKey(env, cursor); err != nil {
		t.Fatal(err)
	}
	if len(api.renewedIDs) != 0 {
		t.Fatalf("renewed %v, want no renewal for a key with an hour left", api.renewedIDs)
	}
	if len(api.mintedNames) != 1 {
		t.Fatalf("minted %v, want exactly one key", api.mintedNames)
	}

	key, err := agentKeyFor(home, "cursor")
	if err != nil || key == nil {
		t.Fatalf("cursor has no key: %v (%v)", key, err)
	}
	almost := time.Now().Add(time.Minute).Unix()
	key.ExpiresAt = &almost
	if err := saveAgentKey(home, "cursor", MintedKey(*key)); err != nil {
		t.Fatal(err)
	}
	if !needsRenew(key, time.Now()) {
		t.Fatal("a key a minute from its expiry needs a renewal")
	}
	if err := mintToolKey(env, cursor); err != nil {
		t.Fatal(err)
	}
	if len(api.renewedIDs) != 1 || api.renewedIDs[0] != "key_cursor" {
		t.Fatalf("renewed %v, want key_cursor", api.renewedIDs)
	}
	if len(api.mintedNames) != 1 {
		t.Fatalf("minted %v, want the same one key", api.mintedNames)
	}
	after, err := agentKeyFor(home, "cursor")
	if err != nil || after == nil {
		t.Fatalf("cursor's key is gone after a renewal: %v (%v)", after, err)
	}
	if after.AccessKeyID != key.AccessKeyID || after.Secret != key.Secret {
		t.Fatal("a renewal replaced the credential, so the tool's own entry broke")
	}
	answered := api.keys["key_cursor"].ExpiresAt
	if answered == nil {
		t.Fatal("the fake Worker sent no expiry with the renewal")
	}
	if after.ExpiresAt == nil || *after.ExpiresAt != *answered {
		t.Fatalf("the stored expiry is %v, want the renewed answer %v", after.ExpiresAt, answered)
	}
	if after.ExpiresAt == nil || !time.Unix(*after.ExpiresAt, 0).After(time.Unix(almost, 0)) {
		t.Fatalf("the stored expiry %v is not past the %d the key had before", after.ExpiresAt, almost)
	}
	if err := mintToolKey(env, cursor); err != nil {
		t.Fatal(err)
	}
	if len(api.renewedIDs) != 1 {
		t.Fatalf("renewed %v, want no renewal for the key that just got its hour", api.renewedIDs)
	}
}

func TestARenewalThatIsRefusedIsReported(t *testing.T) {
	home := t.TempDir()
	api := newFakeAPI()
	api.rejectRenews = true
	server := httptest.NewServer(api)
	defer server.Close()
	client, _ := NewAPIClient(server.URL, "dtok")
	env := Env{Home: home, Minter: ToolMinter{Client: client, Home: home}}.withDefaults()
	cursor, _ := toolByName("cursor")
	if err := mintToolKey(env, cursor); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Minute).Unix()
	key, err := agentKeyFor(home, "cursor")
	if err != nil || key == nil {
		t.Fatalf("cursor has no key: %v (%v)", key, err)
	}
	key.ExpiresAt = &past
	if err := saveAgentKey(home, "cursor", MintedKey(*key)); err != nil {
		t.Fatal(err)
	}
	err = mintToolKey(env, cursor)
	if err == nil {
		t.Fatal("a refused renewal must be reported, not swallowed")
	}
	if !strings.Contains(err.Error(), "The cursor key's hour could not be restarted") {
		t.Fatalf("the failure reads %q, and must name the tool and what failed", err)
	}
	if !strings.Contains(err.Error(), "drive init") {
		t.Fatalf("the failure reads %q, and must end on the command that fixes it", err)
	}
	if err.Error() != failDetail("key-renew-failed", nil, "cursor").Error() {
		t.Fatalf("the failure is %q, and must be the table's own entry", err)
	}
}

func TestARenewalAnswerAboutAnotherKeyIsRefused(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
		want string
	}{
		{
			name: "another key",
			body: map[string]any{"keyId": "key_other", "kind": "agent", "expiresAt": time.Now().Add(time.Hour).Unix()},
			want: "a different key",
		},
		{
			name: "a kind that is not a machine credential",
			body: map[string]any{"keyId": "key_cursor", "kind": "device", "expiresAt": time.Now().Add(time.Hour).Unix()},
			want: "a different key",
		},
		{
			name: "no hour at all",
			body: map[string]any{"keyId": "key_cursor", "kind": "agent", "expiresAt": nil},
			want: "no expiry",
		},
		{
			name: "an hour that has already run out",
			body: map[string]any{"keyId": "key_cursor", "kind": "agent", "expiresAt": time.Now().Add(-time.Minute).Unix()},
			want: "already passed",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			api := newFakeAPI()
			api.keys["key_cursor"] = MintedKey{KeyID: "key_cursor", AccessKeyID: "ak_cursor", Secret: "sk_cursor", Capabilities: []string{"list", "read", "write"}}
			api.renewBody = tc.body
			server := httptest.NewServer(api)
			defer server.Close()
			client, _ := NewAPIClient(server.URL, "dtok")
			env := Env{Home: home, Minter: ToolMinter{Client: client, Home: home}}.withDefaults()
			cursor, _ := toolByName("cursor")
			if err := mintToolKey(env, cursor); err != nil {
				t.Fatal(err)
			}
			almost := time.Now().Add(time.Minute).Unix()
			key, err := agentKeyFor(home, "cursor")
			if err != nil || key == nil {
				t.Fatalf("cursor has no key: %v (%v)", key, err)
			}
			key.ExpiresAt = &almost
			if err := saveAgentKey(home, "cursor", MintedKey(*key)); err != nil {
				t.Fatal(err)
			}

			if _, err := client.RenewKey("key_cursor"); err == nil {
				t.Fatal("a wrong renewal answer must be refused by the client")
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("the failure reads %q, and must say %q", err, tc.want)
			}

			if err = mintToolKey(env, cursor); err == nil {
				t.Fatal("a wrong renewal answer must be refused, not stored")
			}
			if !strings.Contains(err.Error(), "The cursor key's hour could not be restarted") {
				t.Fatalf("the failure reads %q, and must be the table's own entry", err)
			}
			after, err := agentKeyFor(home, "cursor")
			if err != nil || after == nil {
				t.Fatalf("cursor's key is gone: %v (%v)", after, err)
			}
			if after.ExpiresAt == nil || *after.ExpiresAt != almost {
				t.Fatalf("the stored expiry is %v, want the %d it had before", after.ExpiresAt, almost)
			}
		})
	}
}
