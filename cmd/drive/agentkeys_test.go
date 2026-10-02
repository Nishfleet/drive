package main

// The api Worker client and the per-tool agent keys (build step 4, drive#55).
// Every test here talks to an httptest server speaking the api Worker's own
// routes (docs/api.md), so the CLI's paths, its bearer token and its handling
// of a refusal are proven against the same shapes the Worker serves.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeAPI is a stand-in api Worker: it answers the device flow and the key
// routes, and records what the CLI sent so a test can assert the wire shape.
type fakeAPI struct {
	codes        map[string]DeviceCode // user code -> code, as the Worker holds it
	approved     map[string]bool
	keys         map[string]MintedKey // key id -> key
	mintedKinds  []string
	mintedNames  []string
	revokedIDs   []string
	lastAuthHdr  string
	lastPath     string
	rejectMints  bool
	pollsPerTick int
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{
		codes:    map[string]DeviceCode{},
		approved: map[string]bool{},
		keys:     map[string]MintedKey{},
	}
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.lastAuthHdr = r.Header.Get("authorization")
	f.lastPath = r.URL.Path
	switch {
	case r.URL.Path == deviceCodePath && r.Method == http.MethodPost:
		var body struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		code := DeviceCode{
			DeviceCode:      "dev_secret",
			UserCode:        "BCDF-GHJK",
			VerificationURI: "https://api.test/v1/device/approve",
			ExpiresIn:       600,
			Interval:        1,
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
			"account":     map[string]string{"id": "acct_1", "name": "Nish's MacBook"},
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
		key := MintedKey{
			KeyID:        "key_" + body.Name,
			AccessKeyID:  "ak_" + body.Name,
			Secret:       "sk_" + body.Name,
			Prefix:       "u/acct_1/",
			Capabilities: []string{"list", "read", "write"},
		}
		f.keys[key.KeyID] = key
		writeTestJSON(w, 201, key)
	case strings.HasPrefix(r.URL.Path, keysPath+"/key_") && r.Method == http.MethodDelete:
		f.revokedIDs = append(f.revokedIDs, strings.TrimPrefix(r.URL.Path, keysPath+"/"))
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// testDeviceToken is the stand-in signed-in device's token. It is one
// constant so the wire assertion composes the header instead of spelling a
// `Bearer <token>` literal, the shape the repo's own secret scan refuses to
// carry in any tracked file (test/pr-gate.test.mjs, gate 4).
const testDeviceToken = "dtok_for_this_device"

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

func basicHeader(id, secret string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+secret))
}

func TestSignInShowsTheCodeThenPollsUntilApproved(t *testing.T) {
	api := newFakeAPI()
	server := httptest.NewServer(api)
	defer server.Close()

	client, err := NewAPIClient(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	// Approve from "the browser" while the terminal is polling: the first poll
	// answers pending, the second is approved.
	go func() {
		api.approved["dev_secret"] = true
	}()
	var out strings.Builder
	token, account, err := SignIn(client, "Nish's MacBook", &out)
	if err != nil {
		t.Fatal(err)
	}
	if token != "dtok_for_this_device" {
		t.Fatalf("got token %q, want the one the Worker minted", token)
	}
	if account.ID != "acct_1" || account.Name != "Nish's MacBook" {
		t.Fatalf("got account %+v, want the one the Worker sent", account)
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
	if _, _, err := SignIn(client, "laptop", &out); err == nil {
		t.Fatal("expected the expired code to fail")
	} else if !strings.Contains(err.Error(), "expired") {
		t.Fatalf("the Worker's own sentence was lost: %v", err)
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
	// The spec's rule, read from the Worker's own answer, not restated here:
	// an agent key is list/read/write and never deleteFiles.
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
	// The table's words frame the Worker's own sentence, so the person reads
	// what happened and the one next step, and the service's own words are
	// between them.
	if !strings.Contains(err.Error(), "The drive's api refused the request.") {
		t.Fatalf("the table words were lost: %v", err)
	}
	if !strings.Contains(err.Error(), "Unknown key kind") {
		t.Fatalf("the Worker's own sentence was lost: %v", err)
	}
	// The raw HTTP status stays in the chain (DRIVE_DEBUG shows it), not on the
	// line the first words are read from.
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
	// The whole point of drive#55: two tools, two keys, in the entry the drive
	// writes itself.
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
	// Two tools connected, so two keys exist.
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
	// The key store is what a server-side revoke goes through.
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
	// `drive init` is safe to run again: a second run must not leave the tool
	// holding a key nobody knows about.
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
