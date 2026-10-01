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
)

// AgentKeysPath is where the drive keeps the per-tool keys. It sits in the
// same 0600 config directory as the rclone config and the device credentials.
func AgentKeysPath(home string) string {
	return DefaultConfigDir(home) + "/agent-keys.json"
}

// agentKey is one connected tool's key, as stored.
type agentKey struct {
	KeyID        string   `json:"keyId"`
	AccessKeyID  string   `json:"accessKeyId"`
	Secret       string   `json:"secret"`
	Prefix       string   `json:"prefix"`
	Capabilities []string `json:"capabilities"`
}

// loadAgentKeys reads every stored tool key. A missing file is an empty map:
// no tool has been connected with a key yet.
func loadAgentKeys(home string) (map[string]agentKey, error) {
	data, err := os.ReadFile(AgentKeysPath(home))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]agentKey{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", AgentKeysPath(home), err)
	}
	keys := map[string]agentKey{}
	if err := json.Unmarshal(data, &keys); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", AgentKeysPath(home), err)
	}
	return keys, nil
}

// saveAgentKey stores one tool's key, keeping every other tool's.
func saveAgentKey(home, tool string, key MintedKey) error {
	keys, err := loadAgentKeys(home)
	if err != nil {
		return err
	}
	keys[tool] = agentKey{
		KeyID:        key.KeyID,
		AccessKeyID:  key.AccessKeyID,
		Secret:       key.Secret,
		Prefix:       key.Prefix,
		Capabilities: key.Capabilities,
	}
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
	data, err := json.MarshalIndent(keys, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the agent keys: %w", err)
	}
	data = append(data, '\n')
	return WriteFileAtomic(AgentKeysPath(home), data, 0o600)
}
