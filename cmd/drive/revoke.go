package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// RevokePath is the api Worker route that revokes the key presented in the request (workers/api/src/routes.js: the key itself is the whole credential, like the storage routes).
const RevokePath = "/api/keys/revoke"

const revokeTimeout = 10 * time.Second

// KeyPair is the credential this device presents.
type KeyPair struct {
	AccessKeyID string
	SecretKey   string
}

// KeyRevoker is what `drive logout` needs from the key store, and the seam the real key provider (issue #2) implements.
type KeyRevoker interface {
	Revoke(KeyPair) error
}

// APIKeyRevoker asks the api Worker to revoke the key.
type APIKeyRevoker struct {
	BaseURL string
}

// Revoke turns the key off on the server, and says so plainly when it could not.
func (r APIKeyRevoker) Revoke(pair KeyPair) error {
	if pair.AccessKeyID == "" || pair.SecretKey == "" {
		return errors.New("no storage key to revoke: this device's rclone config names no access key id and secret key")
	}
	base, err := parseAPIBase(r.BaseURL)
	if err != nil {
		return err
	}
	endpoint := base + RevokePath
	client := newHTTPClient(revokeTimeout)
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return fmt.Errorf("build POST %s: %w", RevokePath, err)
	}
	req.SetBasicAuth(pair.AccessKeyID, pair.SecretKey)
	req.Header.Set("user-agent", userAgent())
	req.ContentLength = 0
	resp, err := client.Do(req)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return fmt.Errorf("POST %s: %w", RevokePath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return nil
	}
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("POST %s: status %d (want 204 No Content; the key is not known to be off)", RevokePath, resp.StatusCode)
	}
	return nil
}

type noAPIKeyStore struct{}

// Revoke always fails, naming what to set.
func (noAPIKeyStore) Revoke(KeyPair) error {
	return errors.New("no api Worker configured; set --api or DRIVE_API_URL so the key can be revoked on the server")
}

var revokeWarning = messageTable["key-still-live"][0]

const revokePendingWarning = "signed out here; a key from an earlier logout is still live and this device no longer has it; revoke it from the devices page in the web app, then run drive logout --forget-pending"

func pendingRevokePath(home string) string {
	return filepath.Join(filepath.Dir(DefaultConfigDir(home)), "drive-revoke-pending")
}

func receiptBody(ids []string) string {
	var b strings.Builder
	for _, id := range ids {
		b.WriteString("access_key_id=")
		b.WriteString(id)
		b.WriteString("\n")
	}
	return b.String()
}

// WriteRevokePending writes exactly the ids it is given.
func WriteRevokePending(home string, accessKeyIDs ...string) error {
	return WriteFileAtomic(pendingRevokePath(home), []byte(receiptBody(accessKeyIDs)), 0o600)
}

// PendingRevoke reports the access key ids an earlier logout left live.
func PendingRevoke(home string) ([]string, error) {
	data, err := os.ReadFile(pendingRevokePath(home))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read the failed-revoke receipt: %w", err)
	}
	var ids []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		_, id, ok := strings.Cut(line, "=")
		if !ok {
			ids = append(ids, "")
			continue
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func withKeyID(ids []string, id string) []string {
	if containsString(ids, id) {
		return ids
	}
	return append(ids, id)
}

func withoutKeyID(ids []string, drop string) []string {
	kept := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != drop {
			kept = append(kept, id)
		}
	}
	return kept
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// ForgetPendingRevokes clears the failed-revoke record and returns the ids it named.
func ForgetPendingRevokes(home string) ([]string, error) {
	ids, err := PendingRevoke(home)
	if err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	if err := removeIfPresent(pendingRevokePath(home)); err != nil {
		return nil, err
	}
	return ids, nil
}

// NamedKeyIDs renders the ids in a receipt for a person to read: the empty id is a key the CLI could not name, and it is shown as such rather than as a blank.
func NamedKeyIDs(ids []string) string {
	named := make([]string, 0, len(ids))
	for _, id := range ids {
		if id == "" {
			named = append(named, "one it could not name")
			continue
		}
		named = append(named, id)
	}
	return strings.Join(named, ", ")
}

func resolveKeyRevoker(api string) KeyRevoker {
	if strings.TrimSpace(api) == "" {
		return noAPIKeyStore{}
	}
	return APIKeyRevoker{BaseURL: api}
}
