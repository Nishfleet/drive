package main

import (
	"fmt"
	"io"
	"runtime"
	"strings"

	"github.com/Nishfleet/drive/internal/api"
)

func userAgent() string {
	return fmt.Sprintf("drive/%s (%s/%s)", versionText(), runtime.GOOS, runtime.GOARCH)
}

func init() { api.SetUserAgent(userAgent) }

const reSignInLine = "This device's sign-in had expired; signing in again."

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

type deviceReSigner struct {
	home string
	base string
	out  io.Writer
}

// ReSignIn opens the browser once, waits for the approval, and replaces the stored device token.
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
	signed, err := SignIn(client, envDeviceName(r.home), out)
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

func retryable401(err error) bool { return api.Retryable401(err) }

func apiRefusedStatus(err error) string { return api.RefusedStatus(err) }

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

func accountLabel(account Account) string {
	if e := strings.TrimSpace(account.Email); e != "" {
		return e
	}
	if n := strings.TrimSpace(account.Name); n != "" && n != account.ID {
		return n
	}
	return ""
}
