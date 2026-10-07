package api

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

	"github.com/Nishfleet/drive/internal/atomicwrite"
	"github.com/Nishfleet/drive/internal/httpclient"
	"github.com/Nishfleet/drive/internal/login"
)

// wrapFail builds a CLI message-table error. cmd/drive sets this to failDetail
// so people still see the same words; tests that check *failure keep working.
var wrapFail = func(kind string, detail error, args ...string) error {
	if detail != nil {
		return fmt.Errorf("%s: %w", kind, detail)
	}
	return errors.New(kind)
}

// SetFail replaces wrapFail. cmd/drive points it at the message table.
func SetFail(fn func(kind string, detail error, args ...string) error) {
	wrapFail = fn
}

// userAgentHeader is the User-Agent this client sends, or "" when the caller
// set none. The api Worker reads the CLI version out of it and answers 426 with
// the update sentence when the build is below the deployment's configured
// minimum (drive#560), so a shape change under an old CLI names the fix
// instead of surfacing as an unreadable answer. Go's own default
// ("Go-http-client/1.1") carries no version, which is why it is set by hand.
// The value is built in cmd/drive, which owns the version.
var userAgentHeader func() string

// SetUserAgent points the client at the header builder. cmd/drive passes
// userAgent(), which knows the CLI's own version.
func SetUserAgent(fn func() string) { userAgentHeader = fn }

func userAgent() string {
	if userAgentHeader == nil {
		return ""
	}
	return userAgentHeader()
}

// The api Worker's routes, in one place, so a path cannot drift between the
// calls that use it.
const (
	DeviceCodePath  = "/v1/device/code"
	DeviceTokenPath = "/v1/device/token"
	KeysPath        = "/v1/keys"
	QueueReportPath = "/v1/queue"
	deviceCodePath  = DeviceCodePath
	deviceTokenPath = DeviceTokenPath
	keysPath        = KeysPath
	queueReportPath = QueueReportPath
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
	// DownloadURL is the dl Worker base URL with this key's download grant
	// (drive#517), or empty when the deployment has no dl host. The mount
	// reads through it so reads are checked and counted.
	DownloadURL string `json:"downloadUrl,omitempty"`
}

// Account is the account a device token belongs to.
type Account struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Client talks to one api Worker as one signed-in device.
type Client struct {
	Base  string // the api Worker base URL, without a trailing slash
	Token string // the device token from sign-in; empty before it
	HTTP  *http.Client
	// Re is the one way back from a dead device token, and it is nil when this
	// client has no business signing anyone in: the device flow itself, and
	// every call that already holds another credential. See ReSigner.
	Re ReSigner
}

// ReSigner gets a new device token for this machine, having run the device
// flow again, and has already written it over the dead one. It is an interface
// for two reasons, both load-bearing: the retry in do() is provable against a
// stub that hands back a token without a browser, and a client that is holding
// no token to begin with simply leaves it nil and can never sign anyone in by
// accident.
//
// One call, at most, per client: the device flow itself has to reach the api
// Worker with no token, and a second sign-in after a fresh one was refused
// would be a loop with a browser at the end of it.
type ReSigner interface {
	ReSignIn() (token string, expiresAt int64, err error)
}

// New builds a client for a base URL, reusing ParseBase so the same
// value is refused here and at the CLI's parseAPIBase wrapper.
func New(apiBase, token string) (*Client, error) {
	if strings.TrimSpace(apiBase) == "" {
		return nil, wrapFail("no-api", nil)
	}
	base, err := parseAPIBase(apiBase)
	if err != nil {
		return nil, wrapFail("api-url", err)
	}
	return &Client{Base: base, Token: token, HTTP: httpclient.New(apiTimeout)}, nil
}

// post sends a JSON body and decodes a JSON answer. An api Worker error is
// {error: <sentence>} (docs/api.md), so that sentence is kept in the detail
// (DRIVE_DEBUG); the person sees the message table's words for the failure
// class instead of raw text from the service (drive#117).
func (c *Client) post(path string, body, out any) error {
	return c.do(http.MethodPost, path, body, out)
}

// Post sends a JSON body and decodes a JSON answer.
func (c *Client) Post(path string, body, out any) error {
	return c.post(path, body, out)
}

// Do is Post and delete in one place, so the token, the timeout and the error
// shape are the same whichever verb a route uses.
func (c *Client) Do(method, path string, body, out any) error {
	return c.do(method, path, body, out)
}

// do is post and delete in one place, so the token, the timeout and the error
// shape are the same whichever verb a route uses.
//
// do makes exactly one attempt at the call itself. The single retry below is
// the whole of the recovery story for an expired sign-in (drive#557): a 401 on
// an account route means this device's token is past its window, so the client
// signs the machine back in once and sends the very same call again on the new
// token. One retry, never a loop — the second answer is the answer, whether it
// is a success or a refusal, and a client with no ReSigner (the device flow
// itself, anything already holding a key) reports the 401 as it always did.
func (c *Client) do(method, path string, body, out any) error {
	retry, err := c.send(method, path, body, out)
	if err == nil || !retry || c.Re == nil {
		return err
	}
	token, _, signInErr := c.Re.ReSignIn()
	if signInErr != nil {
		// The re-sign-in's own failure is the more useful one to show: why the
		// browser did not open, or why the code expired, rather than the 401
		// that led here. The 401 is still in the chain for DRIVE_DEBUG.
		return fmt.Errorf("%w (the token was also refused with %s)", signInErr, RefusedStatus(err))
	}
	c.Token = token
	_, err = c.send(method, path, body, out)
	return err
}

// Retryable401 says whether this failure is the account gate refusing a token
// and whether a second attempt on a fresh one could answer differently. It is
// the one predicate, so "which failures re-sign in" is written once.
//
// A 401 is the only such status: it is the api Worker's account gate and
// nothing else, and a device token is the only credential here that can go
// stale while the person keeps using the machine.
func Retryable401(err error) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && strings.Contains(apiErr.Status, "401")
}

// RefusedStatus is the status line inside a refusal, for the message that
// explains why a re-sign-in did not rescue a 401.
func RefusedStatus(err error) string {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return "no status"
}

func (c *Client) send(method, path string, body, out any) (bool, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return false, wrapFail("unexpected", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, c.Base+path, reader)
	if err != nil {
		return false, wrapFail("unexpected", err)
	}
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	if c.Token != "" {
		request.Header.Set("authorization", "Bearer "+c.Token)
	}
	if ua := userAgent(); ua != "" {
		request.Header.Set("user-agent", ua)
	}
	client := c.HTTP
	if client == nil {
		client = httpclient.New(apiTimeout)
	}
	response, err := client.Do(request)
	if err != nil {
		return false, wrapFail("offline", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return false, wrapFail("unexpected", err)
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		err := &Error{Method: method, Path: path, Status: response.Status, Body: string(raw)}
		return Retryable401(err), wrapFail(FailureKind(err), err)
	}
	if out == nil {
		return false, nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return false, wrapFail("api-answer", err)
	}
	return false, nil
}

// Error is a call the api Worker refused. Status is the status line and
// Body the Worker's own {error} sentence, so nothing else has to be guessed
// at the call site.
type Error struct {
	Method string
	Path   string
	Status string
	Body   string
}

func (e *Error) Error() string {
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
func (e *Error) Sentence() string {
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
func (c *Client) RequestDeviceCode(deviceName string) (DeviceCode, error) {
	var code DeviceCode
	if err := c.post(deviceCodePath, map[string]string{"name": deviceName}, &code); err != nil {
		// send already classifies the refusal (api-answer/offline/key-revoked)
		// through wrapFail. Returning that error keeps those words; wrapping
		// again here would hide the kind send already named.
		return DeviceCode{}, err
	}
	if code.UserCode == "" || code.DeviceCode == "" || code.VerificationURI == "" {
		return DeviceCode{}, wrapFail("api-answer", nil)
	}
	return code, nil
}

// pollToken asks whether the person has approved the code yet. `pending` is
// the answer that is not yet an answer, so it is a value here and not an
// error. ExpiresAt is the epoch second the approved device token's window ends
// at (drive#557): the Worker states it once, here, and every renewal after that
// is the store's own business, so this poll is the only place the CLI can learn
// how long the token it is about to keep will last.
type pollResult struct {
	Status      string   `json:"status"`
	DeviceToken string   `json:"deviceToken"`
	ExpiresAt   int64    `json:"expiresAt"`
	Account     *Account `json:"account"`
}

func (c *Client) pollToken(deviceCode string) (pollResult, error) {
	var result pollResult
	err := c.post(deviceTokenPath, map[string]string{"device_code": deviceCode}, &result)
	if err == nil {
		return result, nil
	}
	// The Worker answers an expired or unknown code with 400; a poll loop must
	// stop there rather than spin until the CLI's own deadline, with the
	// sign-in-expired words.
	var apiErr *Error
	if errors.As(err, &apiErr) && strings.Contains(apiErr.Status, "400") {
		return result, wrapFail("sign-in-expired", nil)
	}
	return result, wrapFail(FailureKind(err), err)
}

// MintKey asks the api Worker for one key of a kind (POST /v1/keys). `name` is
// the tool the key is for, and it is what `drive agents` lists later.
func (c *Client) MintKey(kind, name string) (MintedKey, error) {
	var key MintedKey
	if err := c.post(keysPath, map[string]string{"kind": kind, "name": name}, &key); err != nil {
		return MintedKey{}, err
	}
	if key.KeyID == "" || key.Secret == "" {
		return MintedKey{}, wrapFail("api-answer", nil)
	}
	return key, nil
}

// RevokeKey cuts a key off server-side (DELETE /v1/keys/<keyId>). A key that
// is refused here is a key that still works, so the local copy is only
// deleted after this returns nil.
func (c *Client) RevokeKey(keyID string) error {
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
func (c *Client) RenewKey(keyID string) (RenewedKey, error) {
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

// ClearQueueReport drops this device's live upload-queue row so a 15-minute
// freshness window cannot show a ghost queue after logout.
func (c *Client) ClearQueueReport() error {
	return c.do(http.MethodDelete, queueReportPath, nil, nil)
}

// RevokeDeviceToken revokes this device's own signed-in token (DELETE
// /v1/device/token). The Authorization header carries the token, so the
// caller revokes exactly its own credential. A 401 from the Worker means the
// token was already dead (revoked or expired), which is the state logout is
// trying to reach; it is not an error. Any other non-2xx is a real failure.
func (c *Client) RevokeDeviceToken() error {
	resp, err := c.DoRaw(http.MethodDelete, deviceTokenPath, nil)
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
		return &Error{Method: "DELETE", Path: deviceTokenPath, Status: resp.Status, Body: string(raw)}
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
func (c *Client) RevokeAllKeys() error {
	resp, err := c.DoRaw(http.MethodDelete, keysPath, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return &Error{Method: "DELETE", Path: keysPath, Status: resp.Status, Body: string(raw)}
	}
	return nil
}

// DoRaw is like do but returns the raw HTTP response without trying to
// unmarshal a body. Used where the caller must handle specific status codes
// (e.g. 401 meaning "already dead"). The Authorization header is set by the
// caller and MUST NEVER BE LOGGED (fleet-ops secret-leak rule: a request
// header containing a bearer token is never printed, so no middleware or
// debug logger may capture the request).
func (c *Client) DoRaw(method, path string, body any) (*http.Response, error) {
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
	if ua := userAgent(); ua != "" {
		request.Header.Set("user-agent", ua)
	}
	client := c.HTTP
	if client == nil {
		client = httpclient.New(apiTimeout)
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
	APIBase     string `json:"apiBase"`
	DeviceToken string `json:"deviceToken"`
	// TokenExpiresAt is the epoch second the DeviceToken's window ends at, as
	// the sign-in answered it. It is 0 on a credentials file written before the
	// answer carried one, and that is not an error: the token is there and still
	// works, and the sliding window the api Worker now applies pushes the date
	// it holds further out on its own (drive#557). It is kept so the CLI can say
	// when a sign-in ends instead of only reporting that it did.
	TokenExpiresAt int64  `json:"tokenExpiresAt,omitempty"`
	AccountID      string `json:"accountId"`
	AccountName    string `json:"accountName"`
	AccountEmail   string `json:"accountEmail,omitempty"`
	Endpoint       string `json:"endpoint,omitempty"`
	Bucket         string `json:"bucket,omitempty"`
	Prefix         string `json:"prefix,omitempty"`
	Region         string `json:"region,omitempty"`
	DownloadURL    string `json:"downloadUrl,omitempty"`
	AccessKeyID    string `json:"accessKeyId,omitempty"`
	KeyID          string `json:"keyId,omitempty"`
	// Device is the name `drive login --device` gave this machine, kept so a
	// later re-sign-in or `drive agents` answers to it and does not register
	// a second device under the hostname (drive#561).
	Device string `json:"device,omitempty"`
}

// CredentialsPath is the signed-in device's own file. It is next to the rclone
// config, which holds the device's storage key, and is deleted by the same
// `drive logout`.
func CredentialsPath(home string) string {
	return filepath.Join(login.DefaultConfigDir(home), "credentials.json")
}

// LoadCredentials reads the signed-in device's credentials. A device that has
// not signed in yet is not an error here: the caller decides what to do about
// a missing file.
func LoadCredentials(home string) (Credentials, error) {
	path := CredentialsPath(home)
	if err := login.CheckSecretFileMode(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Credentials{}, nil
		}
		return Credentials{}, wrapFail("unexpected", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Credentials{}, wrapFail("unexpected", fmt.Errorf("read %s: %w", path, err))
	}
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		// A half-written file is one this package wrote and fsyncs
		// (drive#544), so the failure names the file and the command that
		// writes it back rather than the JSON parser's words.
		return Credentials{}, wrapFail("credentials-unreadable", err, path)
	}
	return creds, nil
}

// SaveCredentials writes the credentials 0600 through the atomic writer, so a
// half-written file can never leave a device that cannot sign in.
func SaveCredentials(home string, creds Credentials) error {
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return wrapFail("unexpected", fmt.Errorf("encode the credentials: %w", err))
	}
	data = append(data, '\n')
	if err := atomicwrite.Write(CredentialsPath(home), data, 0o600); err != nil {
		return err
	}
	return nil
}
