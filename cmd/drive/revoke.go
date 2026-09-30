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
	endpoint := base + RevokePath
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
	req, err := http.NewRequest(http.MethodPost, endpoint, nil)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return fmt.Errorf("build POST %s: %w", RevokePath, err)
	}
	req.SetBasicAuth(pair.AccessKeyID, pair.SecretKey)
	req.ContentLength = 0 // an empty body: the key is in the header and nowhere else
	resp, err := client.Do(req)
	if err != nil {
		// A *url.Error quotes the URL it was given, and a URL is where a
		// credential would sit if the base ever stopped rejecting one. Report
		// the endpoint by its route, never by the value that carried it.
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err
		}
		return fmt.Errorf("POST %s: %w", RevokePath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		// The status number, not resp.Status: the reason phrase is the server's
		// own text, and this is the one channel the file's "nothing to echo"
		// rule left open. A number cannot be talked into carrying a credential.
		return fmt.Errorf("POST %s: status %d (want 204 No Content; the key is not known to be off)", RevokePath, resp.StatusCode)
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
// with, that command could not do it.
//
// It does name the way out. The person's next step is the devices page, where a
// key nobody holds can be turned off, and after that the record has to be
// cleared by hand — `--forget-pending` — because the only proof the CLI could
// otherwise accept is a secret it no longer has. Naming that command is what
// keeps a correct refusal from being a dead end.
const revokePendingWarning = "signed out here; a key from an earlier logout is still live and this device no longer has it; revoke it from the devices page in the web app, then run drive logout --forget-pending"

// pendingRevokePath is the receipt a failed revoke leaves behind, beside the
// config dir rather than inside it (logout deletes that dir, and the receipt
// has to outlive it). It is derived from the config dir rather than spelled out
// again, so the two can never drift apart: if the config dir moves, the receipt
// moves with it.
func pendingRevokePath(home string) string {
	return filepath.Join(filepath.Dir(DefaultConfigDir(home)), "drive-revoke-pending")
}

// receiptBody renders the receipt: the access key ids of every key this device
// has left live, one per line, with an empty value when a key is known to be
// live but could not be named. It is ids, never secrets — an id names a key, it
// does not open one, and without the secret it cannot be replayed.
//
// A set, not one id, because more than one key can be live at once: a revoke
// that failed, then a sign-in that issued a new key, then a revoke that failed
// again, leaves two. A receipt that could only remember the newest would have
// forgotten the first, and the forgetting would be invisible.
func receiptBody(ids []string) string {
	var b strings.Builder
	for _, id := range ids {
		b.WriteString("access_key_id=")
		b.WriteString(id)
		b.WriteString("\n")
	}
	return b.String()
}

// WriteRevokePending writes exactly the ids it is given. It is a plain writer,
// not a merge: the caller (logout.go) has already read what was on file and
// folded this run's revoke into it, and doing the read-modify-write twice would
// give two answers to the same question.
func WriteRevokePending(home string, accessKeyIDs ...string) error {
	return WriteFileAtomic(pendingRevokePath(home), []byte(receiptBody(accessKeyIDs)), 0o600)
}

// PendingRevoke reports the access key ids an earlier logout left live. The
// empty string in the result means a key is known to be live but could not be
// named — a config this run could not parse, or a receipt written by an older
// build. A read failure that is not "there is no receipt" is returned rather
// than folded into absent: a receipt this run cannot read is a key this run
// cannot prove is off, and treating it as absent would be exactly the clean
// sign-out over a live key this command exists to refuse.
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
		// A line that is not an id line is not a key id, and guessing one out
		// of it would be worse than admitting there is one here this run
		// cannot name. The empty id is that admission.
		if !ok {
			ids = append(ids, "")
			continue
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// withKeyID adds an id to a receipt, once. The empty id is a real entry — a key
// that is live but could not be named — and is added like any other.
func withKeyID(ids []string, id string) []string {
	if containsString(ids, id) {
		return ids
	}
	return append(ids, id)
}

// withoutKeyID drops an id from a receipt: that key has been turned off, so it
// is no longer live. Everything else stays, including the unnamed entry.
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

// ForgetPendingRevokes clears the failed-revoke record and returns the ids it
// named. It is the explicit acknowledgment that a key recorded as live has
// been revoked elsewhere — on the devices page — because the CLI cannot re-check
// a key it no longer holds the secret for: without the secret there is no one to
// ask, and no request it could make. It is deliberately not automatic: clearing
// a live-key record on any weaker signal is the clean sign-out over a live key
// this whole receipt exists to refuse.
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

// NamedKeyIDs renders the ids in a receipt for a person to read: the empty id
// is a key the CLI could not name, and it is shown as such rather than as a
// blank.
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

// resolveKeyRevoker picks the KeyRevoker for a run. api is the api Worker base
// URL as configured (flag, environment, or empty).
func resolveKeyRevoker(api string) KeyRevoker {
	if strings.TrimSpace(api) == "" {
		return noAPIKeyStore{}
	}
	return APIKeyRevoker{BaseURL: api}
}
