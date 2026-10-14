package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// AgentKeysPath is where the drive keeps the per-tool keys.
func AgentKeysPath(home string) string {
	return DefaultConfigDir(home) + "/agent-keys.json"
}

type agentKey struct {
	KeyID        string   `json:"keyId"`
	AccessKeyID  string   `json:"accessKeyId"`
	Secret       string   `json:"secret"`
	SessionToken string   `json:"sessionToken,omitempty"`
	Prefix       string   `json:"prefix"`
	Capabilities []string `json:"capabilities"`
	ExpiresAt    *int64   `json:"expiresAt"`
	ExpiresIn    int      `json:"expiresIn,omitempty"`
	Endpoint     string   `json:"endpoint,omitempty"`
	Bucket       string   `json:"bucket,omitempty"`
	Region       string   `json:"region,omitempty"`
	DownloadURL  string   `json:"downloadUrl,omitempty"`
}

const agentKeyTTL = time.Hour

const agentKeyRenewMargin = 5 * time.Minute

func needsRenew(key *agentKey, now time.Time) bool {
	if key == nil || key.ExpiresAt == nil {
		return false
	}
	return !time.Unix(*key.ExpiresAt, 0).After(now.Add(agentKeyRenewMargin))
}

func expiryLabel(expiresAt *int64) string {
	if expiresAt == nil {
		return "renews while this tool uses it"
	}
	return "expires " + time.Unix(*expiresAt, 0).Local().Format("2006-01-02 15:04")
}

func loadAgentKeys(home string) (map[string]agentKey, error) {
	return loadKeyMap(AgentKeysPath(home))
}

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

func saveAgentKey(home, tool string, key MintedKey) error {
	keys, err := loadAgentKeys(home)
	if err != nil {
		return err
	}
	keys[tool] = agentKey(key)
	return writeAgentKeys(home, keys)
}

func removeAgentKey(home, tool string) error {
	keys, err := loadAgentKeys(home)
	if err != nil {
		return err
	}
	delete(keys, tool)
	return writeAgentKeys(home, keys)
}

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

// BranchKeysPath is where the drive keeps each open branch's key.
func BranchKeysPath(home string) string {
	return DefaultConfigDir(home) + "/branch-keys.json"
}

func loadBranchKeys(home string) (map[string]agentKey, error) {
	return loadKeyMap(BranchKeysPath(home))
}

func saveBranchKey(home, name string, key MintedKey) error {
	keys, err := loadBranchKeys(home)
	if err != nil {
		return err
	}
	keys[name] = agentKey(key)
	return writeKeyMap(BranchKeysPath(home), keys)
}

func removeBranchKey(home, name string) error {
	keys, err := loadBranchKeys(home)
	if err != nil {
		return err
	}
	delete(keys, name)
	return writeKeyMap(BranchKeysPath(home), keys)
}

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
