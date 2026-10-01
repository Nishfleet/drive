package main

// The api Worker client: the device sign-in flow and the key routes (build
// step 4, drive#55). One http client, one bearer token, one error shape.
//
// The three routes this file speaks are the api Worker's own (docs/api.md):
// POST /v1/device/code, POST /v1/device/token and the /v1/keys family. The
// device token it keeps is the same credential `GET /v1/keys` and
// `DELETE /v1/keys/<id>` are gated on, so signing in once is what lets a tool
// mint its own key and revoke it again later.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The api Worker's routes, in one place, so a path cannot drift between the
// calls that use it.
const (
	deviceCodePath  = "/v1/device/code"
	deviceTokenPath = "/v1/device/token"
	keysPath        = "/v1/keys"
)

// apiTimeout bounds every call. `drive init` is the first command a person
// runs, and a Worker that never answers must fail with a sentence rather than
// hang the terminal.
const apiTimeout = 30 * time.Second

// DeviceCode is POST /v1/device/code's answer: the code the CLI polls with
// (deviceCode, never shown to the person) and the short one the person types
// on the approval page (UserCode).
type DeviceCode struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	ExpiresIn               int    `json:"expiresIn"`
	Interval                int    `json:"interval"`
}

// MintedKey is POST /v1/keys' answer. Secret is in this response and nowhere
// else: the api Worker keeps only a hash, so this is the one read.
type MintedKey struct {
	KeyID        string   `json:"keyId"`
	AccessKeyID  string   `json:"accessKeyId"`
	Secret       string   `json:"secret"`
	Prefix       string   `json:"prefix"`
	Capabilities []string `json:"capabilities"`
}

// Account is the account a device token belongs to.
type Account struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// APIClient talks to one api Worker as one signed-in device.
type APIClient struct {
	Base  string // the api Worker base URL, without a trailing slash
	Token string // the device token from sign-in; empty before it
	HTTP  *http.Client
}

// NewAPIClient builds a client for a base URL, reusing parseAPIBase's checks
// (status.go) so the same value is refused here and there.
func NewAPIClient(apiBase, token string) (*APIClient, error) {
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return nil, err
	}
	return &APIClient{Base: base, Token: token, HTTP: &http.Client{Timeout: apiTimeout}}, nil
}

// post sends a JSON body and decodes a JSON answer. An api Worker error is
// {error: <sentence>} (docs/api.md), so that sentence is what a person reads
// rather than a bare status code.
func (c *APIClient) post(path string, body, out any) error {
	return c.do(http.MethodPost, path, body, out)
}

// do is post and delete in one place, so the token, the timeout and the error
// shape are the same whichever verb a route uses.
func (c *APIClient) do(method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode the request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, c.Base+path, reader)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, c.Base+path, err)
	}
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	if c.Token != "" {
		request.Header.Set("authorization", "Bearer "+c.Token)
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: apiTimeout}
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("%s %s%s: %w", method, c.Base, path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read %s %s%s: %w", method, c.Base, path, err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return &APIError{Method: method, Path: path, Status: response.Status, Body: string(raw)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("%s %s%s answered %s, which could not be read: %w",
			method, c.Base, path, response.Status, err)
	}
	return nil
}

// APIError is a call the api Worker refused. Status is the status line and
// Body the Worker's own {error} sentence, so nothing else has to be guessed
// at the call site.
type APIError struct {
	Method string
	Path   string
	Status string
	Body   string
}

func (e *APIError) Error() string {
	message := strings.TrimSpace(e.Body)
	var decoded struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(message), &decoded); err == nil && decoded.Error != "" {
		message = decoded.Error
	}
	if message == "" {
		return fmt.Sprintf("%s %s: %s", e.Method, e.Path, e.Status)
	}
	return fmt.Sprintf("%s %s: %s: %s", e.Method, e.Path, e.Status, message)
}

// RequestDeviceCode starts a device sign-in (POST /v1/device/code). The
// device name is the CLI's hostname, so the approval page and the device list
// can tell two machines apart.
func (c *APIClient) RequestDeviceCode(deviceName string) (DeviceCode, error) {
	var code DeviceCode
	if err := c.post(deviceCodePath, map[string]string{"name": deviceName}, &code); err != nil {
		return DeviceCode{}, err
	}
	if code.UserCode == "" || code.DeviceCode == "" || code.VerificationURI == "" {
		return DeviceCode{}, errors.New("the api Worker sent no device code; run `drive init` again in a moment")
	}
	return code, nil
}

// pollToken asks whether the person has approved the code yet. `pending` is
// the answer that is not yet an answer, so it is a value here and not an
// error.
type pollResult struct {
	Status      string   `json:"status"`
	DeviceToken string   `json:"deviceToken"`
	Account     *Account `json:"account"`
}

func (c *APIClient) pollToken(deviceCode string) (pollResult, error) {
	var result pollResult
	err := c.post(deviceTokenPath, map[string]string{"device_code": deviceCode}, &result)
	if err != nil {
		var expired *APIError
		// The Worker answers an expired or unknown code with 400; a poll loop
		// must stop there rather than spin until the CLI's own deadline.
		if errors.As(err, &expired) && strings.Contains(expired.Status, "400") {
			return result, err
		}
		return result, err
	}
	return result, nil
}

// SignIn runs the device flow on the terminal: ask for a code, print it and
// the page to approve it on, then poll until the person approves or the code
// expires. It returns the device token and the account it belongs to; the
// caller keeps both.
func SignIn(client *APIClient, deviceName string, out io.Writer) (string, Account, error) {
	code, err := client.RequestDeviceCode(deviceName)
	if err != nil {
		return "", Account{}, err
	}
	fmt.Fprintf(out, "Approve this device in the browser:\n  %s\n  code: %s\n",
		code.VerificationURI, code.UserCode)
	fmt.Fprintln(out, "Waiting for approval.")

	interval := time.Duration(code.Interval) * time.Second
	if interval < time.Second {
		interval = 5 * time.Second
	}
	deadline := time.Duration(code.ExpiresIn) * time.Second
	if deadline <= 0 {
		deadline = 10 * time.Minute
	}
	wait := time.NewTicker(interval)
	defer wait.Stop()
	timeout := time.After(deadline)
	for {
		select {
		case <-timeout:
			return "", Account{}, errors.New("that code expired before it was approved; run `drive init` again for a new one")
		case <-wait.C:
		}
		result, err := client.pollToken(code.DeviceCode)
		if err != nil {
			return "", Account{}, err
		}
		switch result.Status {
		case "approved":
			if result.DeviceToken == "" || result.Account == nil {
				return "", Account{}, errors.New("the api Worker approved the code but sent no device token; run `drive init` again")
			}
			return result.DeviceToken, *result.Account, nil
		case "pending":
			fmt.Fprint(out, ".")
			continue
		default:
			return "", Account{}, fmt.Errorf("the api Worker answered %q to the device poll; run `drive init` again", result.Status)
		}
	}
}

// MintKey asks the api Worker for one key of a kind (POST /v1/keys). `name` is
// the tool the key is for, and it is what `drive agents` lists later.
func (c *APIClient) MintKey(kind, name string) (MintedKey, error) {
	var key MintedKey
	if err := c.post(keysPath, map[string]string{"kind": kind, "name": name}, &key); err != nil {
		return MintedKey{}, err
	}
	if key.KeyID == "" || key.Secret == "" {
		return MintedKey{}, errors.New("the api Worker sent no key; run `drive init` again in a moment")
	}
	return key, nil
}

// RevokeKey cuts a key off server-side (DELETE /v1/keys/<keyId>). A key that
// is refused here is a key that still works, so the local copy is only
// deleted after this returns nil.
func (c *APIClient) RevokeKey(keyID string) error {
	return c.do(http.MethodDelete, keysPath+"/"+url.PathEscape(keyID), nil, nil)
}

// Credentials is what a signed-in device keeps on disk: where the api Worker
// is and the device token it signs in with. 0600, because the token mints keys.
type Credentials struct {
	APIBase     string `json:"apiBase"`
	DeviceToken string `json:"deviceToken"`
	AccountID   string `json:"accountId"`
	AccountName string `json:"accountName"`
}

// CredentialsPath is the signed-in device's own file. It is next to the rclone
// config, which holds the device's storage key, and is deleted by the same
// `drive logout`.
func CredentialsPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "credentials.json")
}

// LoadCredentials reads the signed-in device's credentials. A device that has
// not signed in yet is not an error here: the caller decides what to do about
// a missing file.
func LoadCredentials(home string) (Credentials, error) {
	data, err := os.ReadFile(CredentialsPath(home))
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{}, nil
	}
	if err != nil {
		return Credentials{}, fmt.Errorf("read %s: %w", CredentialsPath(home), err)
	}
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return Credentials{}, fmt.Errorf("%s is not valid JSON: %w", CredentialsPath(home), err)
	}
	return creds, nil
}

// SaveCredentials writes the credentials 0600 through the atomic writer, so a
// half-written file can never leave a device that cannot sign in.
func SaveCredentials(home string, creds Credentials) error {
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the credentials: %w", err)
	}
	data = append(data, '\n')
	if err := WriteFileAtomic(CredentialsPath(home), data, 0o600); err != nil {
		return err
	}
	return nil
}
