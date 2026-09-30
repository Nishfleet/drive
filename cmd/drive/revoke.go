package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// This is `drive logout`'s half that leaves the machine: turning this device's
// key off on the server before the local copy goes (issue #75).
//
// The key is the `access_key_id` / `secret_access_key` pair in
// `~/.config/drive/rclone.conf` (config.go `RcloneConfig`). Deleting that file
// has always been the whole of `drive logout`, which left the key working on
// the server for anyone who had copied it — the safety finding the 3pm review
// of main opened this issue with. The server-side store is drive#2's job, so
// the call goes through one interface, KeyRevoker, and the implementation is
// the api Worker's own revoke endpoint over HTTP Basic auth. Issue #2's key
// provider implements this same interface, and the test in revoke_test.go
// proves the CLI's half against a test server.

// RevokePath is the api Worker route that revokes the key presented in the
// request (build-spec.md "Devices and agents" — every key with a revoke
// button). The path is the one constant the two halves share: the CLI does not
// guess it and the Worker does not move it.
const RevokePath = "/api/keys/revoke"

// revokeTimeout bounds the call. `drive logout` is a command someone runs when
// something is wrong, so a key store that hangs must not hang the terminal.
const revokeTimeout = 10 * time.Second

// KeyPair is the credential this device presents. It is the same pair
// rclone signs S3 requests with, read from the config file Mount wrote.
type KeyPair struct {
	AccessKeyID string
	SecretKey   string
}

// KeyRevoker is what `drive logout` needs from the key store, and the seam the
// real key provider (issue #2) implements. Logout depends on this and not on
// HTTP, so the proof above is a test server and the real one drops in behind
// the same one method.
type KeyRevoker interface {
	Revoke(KeyPair) error
}

// APIKeyRevoker asks the api Worker to revoke the key. It presents the key
// with HTTP Basic auth, the shape S3-compatible storage itself uses for the
// same credential (rclone's own S3 provider sends Basic auth, which is where
// the key id and secret are already exercised on every upload), so the revoke
// needs no session token and the CLI stores no second credential. The server
// answers 204 No Content when the key is off, and only that: a proxy's 200
// with an error page must never read as a revoked key. The request body is
// empty, so there is nothing to log or to echo, and the response body is not
// relayed either — a server that echoes the presented credential must not get
// the CLI to print it.
type APIKeyRevoker struct {
	BaseURL string // the api Worker base URL, no trailing slash
}

// Revoke turns the key off on the server, and says so plainly when it could
// not. An error here is never papered over into a clean sign-out: a key that
// is still live has to reach the person, because that is the whole difference
// between logging out and pretending to.
func (r APIKeyRevoker) Revoke(pair KeyPair) error {
	if pair.AccessKeyID == "" || pair.SecretKey == "" {
		return errors.New("no storage key to revoke: this device's rclone config names no access key id and secret key")
	}
	base, err := parseAPIBase(r.BaseURL)
	if err != nil {
		return err
	}
	url := base + RevokePath
	client := &http.Client{
		Timeout: revokeTimeout,
		// The key rides in the Authorization header, and Go's client replays
		// that header on a redirect it follows — so a redirect is a way to put
		// the storage secret somewhere it was never meant to go, including a
		// downgrade from https to http on the same host. The revoke endpoint is
		// a fixed route on a configured host and never redirects, so nothing is
		// followed and a 3xx falls out as the non-204 it is.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return fmt.Errorf("build POST %s: %w", url, err)
	}
	req.SetBasicAuth(pair.AccessKeyID, pair.SecretKey)
	req.ContentLength = 0 // an empty body: the key is in the header and nowhere else
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("POST %s: %s (want 204 No Content; the key is not known to be off)", url, resp.Status)
	}
	return nil
}

// noAPIKeyStore is the revoker used when no api Worker is configured. It never
// reports success: there is no server to have turned anything off, so the only
// honest answer is the failure, and Logout turns it into the sentence the
// person reads.
type noAPIKeyStore struct{}

// Revoke always fails, naming what to set. It is deliberately not a silent
// no-op: a logout that cannot revoke must not print the same line as a logout
// that did.
func (noAPIKeyStore) Revoke(KeyPair) error {
	return errors.New("no api Worker configured; set --api or DRIVE_API_URL so the key can be revoked on the server")
}

// revokeWarning is the sentence `drive logout` says when the local copy is
// gone but the key is still live on the server. It is the acceptance text of
// issue #75 and it is written to be read by someone who has just handed the
// machine in, so it names the exact state and the exact next command.
const revokeWarning = "signed out here; the key is still live, run drive logout again when online"

// revokePendingWarning is said by a later `drive logout` that finds a receipt
// from an earlier one whose revoke never landed (pendingRevokePath). The
// receipt proves a key is still live but holds no secret, so this run cannot
// revoke it; saying so is the whole point. It deliberately does not repeat
// revokeWarning's "run drive logout again": with nothing left to authenticate
// with, that command could not do it, and a run that cannot revoke must never
// print a success over a live key.
const revokePendingWarning = "signed out here; a key from an earlier logout is still live and this device no longer has it; revoke it from the devices page in the web app"

// pendingRevokePath is the receipt a failed revoke leaves behind, beside the
// config dir rather than inside it (logout deletes that dir, and the receipt
// has to outlive it). It is derived from the config dir rather than spelled out
// again, so the two can never drift apart: if the config dir moves, the receipt
// moves with it.
func pendingRevokePath(home string) string {
	return filepath.Join(filepath.Dir(DefaultConfigDir(home)), "drive-revoke-pending")
}

// receiptBody is what a receipt holds: the access key id of the key that could
// not be revoked. It is the id, never the secret — an id names a key, it does
// not open one, and without the secret it cannot be replayed. Naming the id is
// what makes the receipt mean something specific: "this key is still live" is a
// statement about one key, and a later logout holding a *different* key must
// not be able to read it as having turned that one off.
func receiptBody(accessKeyID string) string {
	return fmt.Sprintf("access_key_id=%s\n", accessKeyID)
}

// WriteRevokePending leaves the receipt that a failed revoke needs, so the next
// `drive logout` knows which key is still live even though this device no
// longer holds it. It carries no secret and no way to use the key: only the
// access key id, which is the one fact that lets a later run tell "the key I
// revoked is the key that was left live" from "a different key was".
func WriteRevokePending(home, accessKeyID string) error {
	return WriteFileAtomic(pendingRevokePath(home), []byte(receiptBody(accessKeyID)), 0o600)
}

// PendingRevoke reports the access key id an earlier logout left live, or
// ("", false, nil) when no receipt is on file. A stat failure that is not
// "there is no receipt" is returned rather than folded into absent: a receipt
// this run cannot read is a key this run cannot prove is off, and treating it
// as absent would be exactly the clean sign-out over a live key this command
// exists to refuse.
func PendingRevoke(home string) (string, bool, error) {
	data, err := os.ReadFile(pendingRevokePath(home))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("read the failed-revoke receipt: %w", err)
	}
	_, id, ok := strings.Cut(strings.TrimSpace(string(data)), "=")
	if !ok || id == "" {
		return "", true, nil
	}
	return id, true, nil
}

// resolveKeyRevoker picks the KeyRevoker for a run. api is the api Worker base
// URL as configured (flag, environment, or empty).
func resolveKeyRevoker(api string) KeyRevoker {
	if strings.TrimSpace(api) == "" {
		return noAPIKeyStore{}
	}
	return APIKeyRevoker{BaseURL: api}
}
