package main

// The per-tool agent keys the CLI keeps on disk (build step 4, drive#55).
//
// Each connected tool gets its own key from the api Worker: read and write on
// the account's folder, no deleteFiles (build-spec.md "Keys and safety"). The
// CLI is the only place that key is ever readable, and only until it is
// written into the tool's own MCP entry; the api Worker keeps a hash. This
// file is 0600 for the same reason the rclone config is: it is a credential.
//
// One file, keyed by tool name, so `drive agents revoke <tool>` can find and
// revoke exactly that tool's key and no other.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// AgentKeysPath is where the drive keeps the per-tool keys. It sits in the
// same 0600 config directory as the rclone config and the device credentials.
func AgentKeysPath(home string) string {
	return DefaultConfigDir(home) + "/agent-keys.json"
}

// agentKey is one connected tool's key, as stored. It is field-for-field the
// same shape as MintedKey, so the conversion between them stays a plain type
// conversion.
type agentKey struct {
	KeyID        string   `json:"keyId"`
	AccessKeyID  string   `json:"accessKeyId"`
	Secret       string   `json:"secret"`
	SessionToken string   `json:"sessionToken,omitempty"`
	Prefix       string   `json:"prefix"`
	Capabilities []string `json:"capabilities"`
	// ExpiresAt is the epoch second the api Worker stops accepting this
	// credential, or nil for a kind that never expires (a person's own device
	// key). The api Worker renews the window on every request that proves the
	// tool is still using the key, so this value is the mint's answer and is
	// not kept in step with the server: it is what a person reads, never what
	// the CLI decides against (issue #106).
	ExpiresAt *int64 `json:"expiresAt"`
	Endpoint  string `json:"endpoint,omitempty"`
	Bucket    string `json:"bucket,omitempty"`
	Region    string `json:"region,omitempty"`
}

// agentKeyRenewMargin is how close to its expiry a stored agent key is renewed
// on the next `drive init` or `drive agents` run. An idle tool's credential
// dies unused after an hour, and a person should not have to know that to get
// it back: any drive command that finds a tool this close to the edge asks the
// Worker to restart the hour while it still can.
// agentKeyTTL is the hour the api Worker mints an agent key with
// (core/keyprovider.js AGENT_KEY_TTL_SECONDS). The CLI never
// mints a credential of its own, so this constant is what the CLI reads the
// expiry against (the renew margin below) and what tests assert against;
// the api Worker is still the one that hands out the hour.
const agentKeyTTL = time.Hour

const agentKeyRenewMargin = 5 * time.Minute

// needsRenew reports whether a stored key's hour should be restarted now. A key
// with no expiry never needs one.
func needsRenew(key *agentKey, now time.Time) bool {
	if key == nil || key.ExpiresAt == nil {
		return false
	}
	return !time.Unix(*key.ExpiresAt, 0).After(now.Add(agentKeyRenewMargin))
}

// expiryLabel renders a stored key's expiry for a person to read. Two claims
// and no third:
//
//   - an expiry is an instant the api Worker stops accepting the credential
//     at. It is the mint's answer rather than a countdown, because the api
//     Worker renews the window on every request and a countdown would read as
//     something the CLI tracks.
//   - no expiry is a key this file holds from before the hour (the previous
//     CLI stored none), and what is true of it is what is true of every other
//     agent key: the api Worker renews the window while something uses the
//     key. "no expiry" would be a promise the api no longer keeps.
func expiryLabel(expiresAt *int64) string {
	if expiresAt == nil {
		return "renews while this tool uses it"
	}
	return "expires " + time.Unix(*expiresAt, 0).Local().Format("2006-01-02 15:04")
}

// loadAgentKeys reads every stored tool key. A missing file is an empty map:
// no tool has been connected with a key yet.
func loadAgentKeys(home string) (map[string]agentKey, error) {
	return loadKeyMap(AgentKeysPath(home))
}

// loadKeyMap reads a 0600 JSON map of stored keys. A missing file is an empty
// map, so a first mint and a first branch share the same "nothing here yet"
// answer.
func loadKeyMap(path string) (map[string]agentKey, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]agentKey{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	keys := map[string]agentKey{}
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return keys, nil
}

// saveAgentKey stores one tool's key, keeping every other tool's.
func saveAgentKey(home, tool string, key MintedKey) error {
	keys, err := loadAgentKeys(home)
	if err != nil {
		return err
	}
	// MintedKey and agentKey are field-for-field the same shape, so the
	// conversion is a plain type conversion: one less field list to keep in
	// step when a key gains a field.
	keys[tool] = agentKey(key)
	return writeAgentKeys(home, keys)
}

// removeAgentKey forgets one tool's key after it has been revoked server-side.
func removeAgentKey(home, tool string) error {
	keys, err := loadAgentKeys(home)
	if err != nil {
		return err
	}
	delete(keys, tool)
	return writeAgentKeys(home, keys)
}

// agentKeyFor returns a tool's stored key, or nil when it has none.
func agentKeyFor(home, tool string) (*agentKey, error) {
	keys, err := loadAgentKeys(home)
	if err != nil {
		return nil, err
	}
	key, ok := keys[tool]
	if !ok {
		return nil, nil
	}
	return &key, nil
}

// writeAgentKeys writes the map atomically at 0600. An empty map is written
// rather than deleting the file, so a reader cannot mistake "gone" for "not
// yet read".
func writeAgentKeys(home string, keys map[string]agentKey) error {
	return writeKeyMap(AgentKeysPath(home), keys)
}

func writeKeyMap(path string, keys map[string]agentKey) error {
	data, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the keys: %w", err)
	}
	data = append(data, '\n')
	return WriteFileAtomic(path, data, 0o600)
}

// BranchKeysPath is where the drive keeps each open branch's key. It is a
// second file, not agent-keys.json, so a branch named after a tool cannot
// overwrite that tool's key (drive#156). Same 0600 config directory.
func BranchKeysPath(home string) string {
	return DefaultConfigDir(home) + "/branch-keys.json"
}

func loadBranchKeys(home string) (map[string]agentKey, error) {
	return loadKeyMap(BranchKeysPath(home))
}

// saveBranchKey stores one branch's key, keeping every other open branch's.
func saveBranchKey(home, name string, key MintedKey) error {
	keys, err := loadBranchKeys(home)
	if err != nil {
		return err
	}
	keys[name] = agentKey(key)
	return writeKeyMap(BranchKeysPath(home), keys)
}

// removeBranchKey forgets one branch's key after approve or discard has
// revoked it, or after a re-mint replaced it.
func removeBranchKey(home, name string) error {
	keys, err := loadBranchKeys(home)
	if err != nil {
		return err
	}
	delete(keys, name)
	return writeKeyMap(BranchKeysPath(home), keys)
}

// branchKeyFor returns a branch's stored key, or nil when it has none.
func branchKeyFor(home, name string) (*agentKey, error) {
	keys, err := loadBranchKeys(home)
	if err != nil {
		return nil, err
	}
	key, ok := keys[name]
	if !ok {
		return nil, nil
	}
	return &key, nil
}
