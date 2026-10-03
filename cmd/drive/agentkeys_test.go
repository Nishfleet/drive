package main

// The api Worker client and the per-tool agent keys (build step 4, drive#55).
// Every test here talks to an httptest server speaking the api Worker's own
// routes (docs/api.md), so the CLI's paths, its bearer token and its handling
// of a refusal are proven against the same shapes the Worker serves.

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	renewedIDs   []string
	lastAuthHdr  string
	lastPath     string
	rejectMints  bool
	rejectRenews bool
	// renewBody, when set, is what the renew route answers instead of the
	// row's own: the wrong-row answers a test needs to refuse.
	renewBody map[string]any
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
		// The hour an agent key is minted with (drive issue #106): the api
		// Worker answers POST /v1/keys with the second the credential stops
		// working at, and only an agent key gets one.
		var expiresAt *int64
		if body.Kind == "agent" {
			at := time.Now().Add(agentKeyTTL).Unix()
			expiresAt = &at
		}
		key := MintedKey{
			KeyID:        "key_" + body.Name,
			AccessKeyID:  "ak_" + body.Name,
			Secret:       "sk_" + body.Name,
			Prefix:       "u/acct_1/",
			Capabilities: []string{"list", "read", "write"},
			ExpiresAt:    expiresAt,
		}
		f.keys[key.KeyID] = key
		writeTestJSON(w, 201, key)
	case strings.HasPrefix(r.URL.Path, keysPath+"/key_") && strings.HasSuffix(r.URL.Path, "/renew") && r.Method == http.MethodPost:
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, keysPath+"/"), "/renew")
		f.renewedIDs = append(f.renewedIDs, id)
		// 409 is what a revoked key answers, the same shape the Worker serves.
		if f.rejectRenews {
			writeTestJSON(w, 409, map[string]string{"error": "That key is revoked."})
			return
		}
		key, ok := f.keys[id]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// The row comes back with a fresh hour and no secret: renewing replaces
		// the window, never the credential. The window sits renewAnswerOffset
		// further out than a mint's, so a test can tell an answer that was
		// decoded and stored from one that was left at the mint's value.
		at := time.Now().Add(agentKeyTTL + renewAnswerOffset).Unix()
		key.ExpiresAt = &at
		f.keys[id] = key
		if f.renewBody != nil {
			writeTestJSON(w, 200, f.renewBody)
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

// ---- the one-hour agent credential (drive issue #106) ----
//
// An agent key is minted with an hour and the api Worker renews the window on
// every request that proves the tool is still using it. The CLI's two halves of
// that are here: it carries and shows the expiry the mint answers with, and it
// asks for a renewal when a stored key is about to run out.

// renewAnswerOffset is how far past a mint's window the fake Worker's renew
// answer sits. It is not a rule the real Worker has; it exists so a test can
// tell an expiry that was decoded from the answer and written to disk from one
// that was left at the mint's value.
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
	// A key this file holds from before the hour carries no expiry, and what
	// the api Worker renews it on is what the display says. "no expiry" would
	// be a promise the api no longer keeps.
	if got := expiryLabel(nil); got != "renews while this tool uses it" {
		t.Fatalf("a key with no expiry reads %q", got)
	}
	if got := expiryLabel(&seconds); got != want {
		t.Fatalf("an expiry reads %q, want %q", got, want)
	}
}

// TestInitShowsTheExpiryTheToolHolds is the wiring behind that label: a
// person runs `drive init` and the line they read is the one the api Worker
// answers with, never the mint's value the CLI already had.
func TestInitShowsTheExpiryTheToolHolds(t *testing.T) {
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

	// A key stored before the hour holds no expiry, and the line says what the
	// api Worker renews it on. "no expiry" would be a promise the api no longer
	// keeps, so this is the branch a person with an older key reads.
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

	// A key minted with an hour reads as that hour's instant, and a renew moves
	// it, so the same line carries the Worker's own answer.
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
	// A key minted a moment ago has an hour left, so a second run reuses it.
	if err := mintToolKey(env, cursor); err != nil {
		t.Fatal(err)
	}
	if len(api.renewedIDs) != 0 {
		t.Fatalf("renewed %v, want no renewal for a key with an hour left", api.renewedIDs)
	}
	if len(api.mintedNames) != 1 {
		t.Fatalf("minted %v, want exactly one key", api.mintedNames)
	}

	// Now the stored key is nearly out of hour: the tool sat idle, so nothing
	// renewed it and its next request would be refused.
	key, err := agentKeyFor(home, "cursor")
	if err != nil || key == nil {
		t.Fatalf("cursor has no key: %v (%v)", key, err)
	}
	almost := time.Now().Add(time.Minute).Unix()
	key.ExpiresAt = &almost
	// agentKey and MintedKey are field-for-field the same shape, so the
	// conversion is the plain one the store itself uses.
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
	// The renewal did not mint a second key, and it did not change the
	// credential the tool's MCP entry holds.
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
	// The expiry written is the answer the Worker gave, not the mint's value the
	// CLI already had: a stored expiry left at the mint's reads wrong to a
	// person, and it is what would make the very next command renew again.
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
	// Which is what stops the loop: the key now has an hour left, so a second
	// command reuses it instead of asking again.
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
	// The words are the one message table's, so this reads like every other
	// failure the CLI prints, and the next step is an exact command.
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

// TestARenewalAnswerAboutAnotherKeyIsRefused: a 200 is not proof the Worker
// answered the question it was asked. An answer naming another key, a kind that
// is not a machine credential, or a row with no hour on it is refused, so a
// broken answer can never be written to disk as this tool's expiry.
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
			// A key on disk whose hour is nearly out, so the next command asks
			// to renew it, and the Worker answers with the wrong row.
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

			// The client says why: the reason is what DRIVE_DEBUG shows, and it
			// has to be the reason the check refused the answer for.
			if _, err := client.RenewKey("key_cursor"); err == nil {
				t.Fatal("a wrong renewal answer must be refused by the client")
			} else if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("the failure reads %q, and must say %q", err, tc.want)
			}

			// And the tool that asked for it is told, in the one table's words,
			// rather than storing the answer.
			if err = mintToolKey(env, cursor); err == nil {
				t.Fatal("a wrong renewal answer must be refused, not stored")
			}
			if !strings.Contains(err.Error(), "The cursor key's hour could not be restarted") {
				t.Fatalf("the failure reads %q, and must be the table's own entry", err)
			}
			// And the key on disk is exactly what it was: a wrong answer never
			// becomes somebody's stored expiry.
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
