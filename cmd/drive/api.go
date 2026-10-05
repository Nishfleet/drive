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
	"runtime"
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
// else: the api Worker keeps only a hash, so this is the one read. ExpiresAt
// is the epoch second an agent's credential stops working at, and it is nil for
// a kind that never expires (a person's own device key, issue #106). It is a
// pointer so an absent field and a key with no expiry stay distinguishable.
type MintedKey struct {
	KeyID        string   `json:"keyId"`
	AccessKeyID  string   `json:"accessKeyId"`
	Secret       string   `json:"secret"`
	SessionToken string   `json:"sessionToken,omitempty"`
	Prefix       string   `json:"prefix"`
	Capabilities []string `json:"capabilities"`
	ExpiresAt    *int64   `json:"expiresAt"`
	Endpoint     string   `json:"endpoint,omitempty"`
	Bucket       string   `json:"bucket,omitempty"`
	Region       string   `json:"region,omitempty"`
}

// Account is the account a device token belongs to.
type Account struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
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
	if strings.TrimSpace(apiBase) == "" {
		return nil, fail("no-api")
	}
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return nil, failDetail("api-url", err)
	}
	return &APIClient{Base: base, Token: token, HTTP: &http.Client{Timeout: apiTimeout}}, nil
}

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

// post sends a JSON body and decodes a JSON answer. An api Worker error
// is {error: <sentence>} (docs/api.md), so that sentence is kept in the
// detail (DRIVE_DEBUG); the person sees the message table's words for
// the failure class instead of raw text from the service (drive#117).
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
			return failDetail("unexpected", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, c.Base+path, reader)
	if err != nil {
		return failDetail("unexpected", err)
	}
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	if c.Token != "" {
		request.Header.Set("authorization", "Bearer "+c.Token)
	}
	request.Header.Set("user-agent", userAgent())
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: apiTimeout}
	}
	response, err := client.Do(request)
	if err != nil {
		return failDetail("offline", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return failDetail("unexpected", err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		err := &APIError{Method: method, Path: path, Status: response.Status, Body: string(raw)}
		f := failDetail(apiFailureKind(err), err)
		if s := err.Sentence(); s != "" {
			f = f.withService(s)
		}
		return f
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return failDetail("api-answer", err)
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
	if s := e.Sentence(); s != "" {
		message = s
	}
	if message == "" {
		return fmt.Sprintf("%s %s: %s", e.Method, e.Path, e.Status)
	}
	return fmt.Sprintf("%s %s: %s: %s", e.Method, e.Path, e.Status, message)
}

// Sentence is the api Worker's own {error} sentence (docs/api.md), when the
// body carried one. A person reads that sentence rather than a status code.
func (e *APIError) Sentence() string {
	var decoded struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(e.Body)), &decoded); err != nil {
		return ""
	}
	return decoded.Error
}

// RequestDeviceCode starts a device sign-in (POST /v1/device/code). The
// device name is the CLI's hostname, so the approval page and the device list
// can tell two machines apart.
func (c *APIClient) RequestDeviceCode(deviceName string) (DeviceCode, error) {
	var code DeviceCode
	if err := c.post(deviceCodePath, map[string]string{"name": deviceName}, &code); err != nil {
		// A Worker that reaches this route but answers with something unusable
		// is classified by do() (api-answer/offline/key-revoked); keep those
		// words, and never let an unclassified error through.
		var f *failure
		if errors.As(err, &f) {
			return DeviceCode{}, f
		}
		return DeviceCode{}, failDetail("unexpected", err)
	}
	if code.UserCode == "" || code.DeviceCode == "" || code.VerificationURI == "" {
		return DeviceCode{}, fail("api-answer")
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
	if err == nil {
		return result, nil
	}
	// The Worker answers an expired or unknown code with 400; a poll loop must
	// stop there rather than spin until the CLI's own deadline, with the
	// sign-in-expired words.
	var apiErr *APIError
	if errors.As(err, &apiErr) && strings.Contains(apiErr.Status, "400") {
		return result, fail("sign-in-expired")
	}
	return result, failDetail(apiFailureKind(err), err)
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
	page := code.VerificationURIComplete
	if page == "" {
		page = code.VerificationURI
	}
	fmt.Fprintf(out, "Approve this device in the browser:\n  %s\n  code: %s\n",
		page, code.UserCode)
	if err := openURL(page); err != nil {
		fmt.Fprintln(out, "Could not open the browser. Open that page.")
	}
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
			return "", Account{}, fail("sign-in-expired")
		case <-wait.C:
		}
		result, err := client.pollToken(code.DeviceCode)
		if err != nil {
			return "", Account{}, err
		}
		switch result.Status {
		case "approved":
			if result.DeviceToken == "" || result.Account == nil {
				return "", Account{}, fail("api-answer")
			}
			return result.DeviceToken, *result.Account, nil
		case "pending":
			fmt.Fprint(out, ".")
			continue
		default:
			return "", Account{}, failDetail("api-answer", fmt.Errorf("the api Worker answered %q to the device poll", result.Status))
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
		return MintedKey{}, fail("api-answer")
	}
	return key, nil
}

// RevokeKey cuts a key off server-side (DELETE /v1/keys/<keyId>). A key that
// is refused here is a key that still works, so the local copy is only
// deleted after this returns nil.
func (c *APIClient) RevokeKey(keyID string) error {
	return c.do(http.MethodDelete, keysPath+"/"+url.PathEscape(keyID), nil, nil)
}

// RenewedKey is POST /v1/keys/<keyId>/renew's answer: the key's public
// row after the restart. It carries no secret, because a restart changes
// nothing about the credential — only the server-side window moves, so the
// tool's own MCP entry still holds the pair that now works again.
type RenewedKey struct {
	KeyID        string   `json:"keyId"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Capabilities []string `json:"capabilities"`
	// ExpiresAt is the epoch second the api Worker stops accepting the
	// credential after this restart, or nil for a kind that never expires.
	ExpiresAt *int64 `json:"expiresAt"`
}

// RenewKey restarts the hour on one of this device's keys (POST
// /v1/keys/<keyId>/renew, issue #106).
//
// An agent key is minted with an hour and the api Worker renews it on every
// request that proves the tool is still using it, so a connected tool never
// notices. A tool that sat idle for longer than its hour outlives its
// credential, though: nothing used the key, so nothing renewed it, and its
// next request is refused. This call is the way back, and it is the device's
// own signed-in token that asks — a leaked storage key holds no device token,
// so it cannot restart its own hour.
//
// The credential is not replaced, so the tool's own MCP entry keeps working.
// What it does replace is the expiry the CLI shows and decides against, and
// that is why the answer comes back rather than being dropped: a stored
// expiry left at the mint's value would keep reading as "an hour from when
// the key was made", which is both wrong to show and a reason to renew again
// on the very next command. 409 means the key is revoked, which is the state
// `drive agents revoke` reaches on purpose.
func (c *APIClient) RenewKey(keyID string) (RenewedKey, error) {
	var renewed RenewedKey
	if err := c.do(http.MethodPost, keysPath+"/"+url.PathEscape(keyID)+"/renew", nil, &renewed); err != nil {
		return RenewedKey{}, err
	}
	// The answer is checked against the question, because a 200 with the wrong
	// body would otherwise be stored as this key's expiry: a body that names
	// another key, a kind that is not a machine credential, or a row with no
	// hour on it is refused here rather than written to disk. The Worker owns
	// this row, so anything else about the answer is its own business, not
	// something the CLI second-guesses.
	if renewed.KeyID != keyID || renewed.Kind != "agent" {
		return RenewedKey{}, errors.New("the api Worker answered about a different key; run `drive init` again in a moment")
	}
	if renewed.ExpiresAt == nil {
		return RenewedKey{}, errors.New("the api Worker sent no expiry for the key; run `drive init` again in a moment")
	}
	if *renewed.ExpiresAt <= time.Now().Unix() {
		return RenewedKey{}, errors.New("the api Worker sent an expiry that has already passed; run `drive init` again in a moment")
	}
	return renewed, nil
}

// RevokeDeviceToken revokes this device's own signed-in token (DELETE
// /v1/device/token). The Authorization header carries the token, so the
// caller revokes exactly its own credential. A 401 from the Worker means the
// token was already dead (revoked or expired), which is the state logout is
// trying to reach; it is not an error. Any other non-2xx is a real failure.
func (c *APIClient) RevokeDeviceToken() error {
	resp, err := c.doRaw(http.MethodDelete, deviceTokenPath, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		// The token was already dead; that is the state we want.
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return &APIError{Method: "DELETE", Path: deviceTokenPath, Status: resp.Status, Body: string(raw)}
	}
	return nil
}

// RevokeAllKeys signs the account out of every device at once (DELETE
// /v1/keys). It is the account-wide half of logout: the route takes no body and
// no key id, and revokes every live key and every live device token on the
// account the Worker resolved from this very token, so there is nothing here a
// caller could point at another account (drive#236).
//
// The same Authorization header is the whole credential, so the token this call
// presents is one of the tokens the call revokes — including its own. The
// answer therefore still gets out; the next request with that token is the 401
// a signed-out device must get. That is why the account-wide revoke is the first
// half of `drive logout --all` and the local sign-out is the second, and why
// this call must not come after the device-token revoke: a token already dead
// answers 401 here, which this method would read as "already signed out" and
// skip the account behind it.
//
// A 401 is therefore NOT treated as success here, the way it is in
// RevokeDeviceToken: there, a dead token IS the state wanted; here, a dead token
// means every device on the account is still live and the person is being told
// nothing happened. Any non-2xx is a real failure and is reported, so the local
// half does not run over an account that is still signed in everywhere.
func (c *APIClient) RevokeAllKeys() error {
	resp, err := c.doRaw(http.MethodDelete, keysPath, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return &APIError{Method: "DELETE", Path: keysPath, Status: resp.Status, Body: string(raw)}
	}
	return nil
}

// doRaw is like do but returns the raw HTTP response without trying to
// unmarshal a body. Used where the caller must handle specific status codes
// (e.g. 401 meaning "already dead"). The Authorization header is set by the
// caller and MUST NEVER BE LOGGED (fleet-ops secret-leak rule: a request
// header containing a bearer token is never printed, so no middleware or
// debug logger may capture the request).
func (c *APIClient) doRaw(method, path string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode the request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, c.Base+path, reader)
	if err != nil {
		return nil, fmt.Errorf("%s %s: %w", method, c.Base+path, err)
	}
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	if c.Token != "" {
		request.Header.Set("authorization", "Bearer "+c.Token)
	}
	request.Header.Set("user-agent", userAgent())
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: apiTimeout}
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%s %s%s: %w", method, c.Base, path, err)
	}
	return response, nil
}

// Credentials is what a signed-in device keeps on disk: the one api base this
// device signed in to, and the device token it signs in with. 0600, because
// the token mints keys.
//
// One host fronts both Worker families (drive#156): /api/* is the site
// Worker (branches, search, files) and /v1/* is the api Worker (keys, device
// sign-in). APIBase is that host. There is no second keysBase; MintKey and
// the branch routes share this client. A deployment that splits the two
// Workers still fronts them on this one base, the same contract `drive
// agents` already uses for POST /v1/keys.
type Credentials struct {
	APIBase      string `json:"apiBase"`
	DeviceToken  string `json:"deviceToken"`
	AccountID    string `json:"accountId"`
	AccountName  string `json:"accountName"`
	AccountEmail string `json:"accountEmail,omitempty"`
	Endpoint     string `json:"endpoint,omitempty"`
	Bucket       string `json:"bucket,omitempty"`
	Prefix       string `json:"prefix,omitempty"`
	Region       string `json:"region,omitempty"`
	DownloadURL  string `json:"downloadUrl,omitempty"`
	AccessKeyID  string `json:"accessKeyId,omitempty"`
	KeyID        string `json:"keyId,omitempty"`
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
		return Credentials{}, failDetail("unexpected", fmt.Errorf("read %s: %w", CredentialsPath(home), err))
	}
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return Credentials{}, failDetail("unexpected", fmt.Errorf("%s is not valid JSON: %w", CredentialsPath(home), err))
	}
	return creds, nil
}

// SaveCredentials writes the credentials 0600 through the atomic writer, so a
// half-written file can never leave a device that cannot sign in.
func SaveCredentials(home string, creds Credentials) error {
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return failDetail("unexpected", fmt.Errorf("encode the credentials: %w", err))
	}
	data = append(data, '\n')
	if err := WriteFileAtomic(CredentialsPath(home), data, 0o600); err != nil {
		return err
	}
	return nil
}

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
