package main

import (
	"fmt"
	"io"
	"runtime"
	"strings"

	"github.com/Nishfleet/drive/internal/api"
)

// userAgent is what every drive request to the api names itself with:
// drive/<version> (<os>/<arch>). The api Worker reads the version out
// of it and answers 426 with the update sentence when the version is
// below the deployment's configured minimum (drive#560), so an api
// shape change under an old CLI names the fix instead of surfacing as
// an unreadable answer. Go's own default ("Go-http-client/1.1")
// carries no version, which is why the header is set by hand on every
// request this client sends.
func userAgent() string {
	return fmt.Sprintf("drive/%s (%s/%s)", versionText(), runtime.GOOS, runtime.GOARCH)
}

func init() { api.SetUserAgent(userAgent) }

// reSignInLine is what the CLI prints before it opens a browser, once, when an
// account route refuses a token and the CLI signs this machine back in
// (drive#557). It is a line, not a paragraph: the person is looking at a
// command that stopped working, and the one thing they need to know is that
// this is normal and the browser is about to open.
const reSignInLine = "This device's sign-in had expired; signing in again."

// signedInClient builds the client every account route uses: this device's
// token from the credentials file, plus the way back when that token is dead.
// It is the one place those two are wired together, so no command can end up
// with a client that can never re-sign in and another that re-signs in without
// being asked (drive#557).
func signedInClient(home, apiBase string, out io.Writer) (*APIClient, error) {
	creds, err := LoadCredentials(home)
	if err != nil {
		return nil, err
	}
	base, err := resolveAPIBase(home, apiBase)
	if err != nil {
		return nil, err
	}
	client, err := NewAPIClient(base, creds.DeviceToken)
	if err != nil {
		return nil, err
	}
	client.Re = deviceReSigner{home: home, base: base, out: out}
	return client, nil
}

// deviceReSigner is the real ReSigner: it runs the device flow again for this
// machine and writes the new token over the dead one, so the very next
// account call in the same command is already signed in again. It reads the
// base and the account it is signing in to from the credentials file, which is
// the same file the dead token came from, so a re-sign-in lands on the account
// the person was already using rather than whichever one answers first.
type deviceReSigner struct {
	home string
	base string
	out  io.Writer
}

// ReSignIn opens the browser once, waits for the approval, and replaces the
// stored device token. The stored APIBase is rewritten with the same value it
// already had only so a credentials file written by a run that predates it
// still ends up complete.
func (r deviceReSigner) ReSignIn() (string, int64, error) {
	creds, err := LoadCredentials(r.home)
	if err != nil {
		return "", 0, err
	}
	client, err := NewAPIClient(r.base, "")
	if err != nil {
		return "", 0, err
	}
	out := r.out
	if out == nil {
		out = io.Discard
	}
	fmt.Fprintln(out, reSignInLine)
	signed, err := SignIn(client, deviceName(), out)
	if err != nil {
		return "", 0, err
	}
	creds.APIBase = r.base
	creds.DeviceToken = signed.Token
	creds.TokenExpiresAt = signed.ExpiresAt
	creds.AccountID = signed.Account.ID
	creds.AccountName = signed.Account.Name
	creds.AccountEmail = signed.Account.Email
	if err := SaveCredentials(r.home, creds); err != nil {
		return "", 0, err
	}
	return signed.Token, signed.ExpiresAt, nil
}

// retryable401 says whether this failure is the account gate refusing a token
// and whether a second attempt on a fresh one could answer differently. It is
// the one predicate, so "which failures re-sign in" is written once.
func retryable401(err error) bool { return api.Retryable401(err) }

// apiRefusedStatus is the status line inside a refusal, for the message that
// explains why a re-sign-in did not rescue a 401.
func apiRefusedStatus(err error) string { return api.RefusedStatus(err) }

// resolveAPIBase is --api / DRIVE_API_URL, then the apiBase `drive login`
// wrote, then the live site when this device already holds a token. Empty
// means this machine has not signed in and the caller did not pass an address.
func resolveAPIBase(home, explicit string) (string, error) {
	if v := strings.TrimSpace(explicit); v != "" {
		return v, nil
	}
	creds, err := LoadCredentials(home)
	if err != nil {
		return "", err
	}
	if v := strings.TrimSpace(creds.APIBase); v != "" {
		return v, nil
	}
	if strings.TrimSpace(creds.DeviceToken) != "" {
		return defaultAPIBase, nil
	}
	return "", nil
}

// accountLabel is the words `drive login` prints after "Signed in as": the
// email a person recognises, never the account id.
func accountLabel(account Account) string {
	if e := strings.TrimSpace(account.Email); e != "" {
		return e
	}
	if n := strings.TrimSpace(account.Name); n != "" && n != account.ID {
		return n
	}
	return ""
}
