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

var wrapFail = func(kind string, detail error, args ...string) error {
	if detail != nil {
		return fmt.Errorf("%s: %w", kind, detail)
	}
	return errors.New(kind)
}

// SetFail replaces wrapFail.
func SetFail(fn func(kind string, detail error, args ...string) error) {
	wrapFail = fn
}

var userAgentHeader func() string

// SetUserAgent points the client at the header builder.
func SetUserAgent(fn func() string) { userAgentHeader = fn }

func userAgent() string {
	if userAgentHeader == nil {
		return ""
	}
	return userAgentHeader()
}

// The api Worker's routes, in one place, so a path cannot drift between the calls that use it.
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

const apiTimeout = 30 * time.Second

// DeviceCode is POST /v1/device/code's answer: the code the CLI polls with (deviceCode, never shown to the person) and the short one the person types on the approval page (UserCode).
type DeviceCode struct {
	DeviceCode              string `json:"deviceCode"`
	UserCode                string `json:"userCode"`
	VerificationURI         string `json:"verificationUri"`
	VerificationURIComplete string `json:"verificationUriComplete"`
	ExpiresIn               int    `json:"expiresIn"`
	Interval                int    `json:"interval"`
}

// MintedKey is POST /v1/keys' answer.
type MintedKey struct {
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

// Account is the account a device token belongs to.
type Account struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// Client talks to one api Worker as one signed-in device.
type Client struct {
	Base  string
	Token string
	HTTP  *http.Client
	Re    ReSigner
}

// ReSigner gets a new device token for this machine, having run the device flow again, and has already written it over the dead one.
type ReSigner interface {
	ReSignIn() (token string, expiresAt int64, err error)
}

// New builds a client for a base URL, reusing ParseBase so the same value is refused here and at the CLI's parseAPIBase wrapper.
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

func (c *Client) post(path string, body, out any) error {
	return c.do(http.MethodPost, path, body, out)
}

// Post sends a JSON body and decodes a JSON answer.
func (c *Client) Post(path string, body, out any) error {
	return c.post(path, body, out)
}

// Do is Post and delete in one place, so the token, the timeout and the error shape are the same whichever verb a route uses.
func (c *Client) Do(method, path string, body, out any) error {
	return c.do(method, path, body, out)
}

func (c *Client) do(method, path string, body, out any) error {
	retry, err := c.send(method, path, body, out)
	if err == nil || !retry || c.Re == nil {
		return err
	}
	token, _, signInErr := c.Re.ReSignIn()
	if signInErr != nil {
		return fmt.Errorf("%w (the token was also refused with %s)", signInErr, RefusedStatus(err))
	}
	c.Token = token
	_, err = c.send(method, path, body, out)
	return err
}

// Retryable401 says whether this failure is the account gate refusing a token and whether a second attempt on a fresh one could answer differently.
func Retryable401(err error) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && strings.Contains(apiErr.Status, "401")
}

// RefusedStatus is the status line inside a refusal, for the message that explains why a re-sign-in did not rescue a 401.
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
		var tableFailure interface{ TableFailure() }
		if errors.As(err, &tableFailure) {
			return false, err
		}
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

// Error is a call the api Worker refused.
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

// Sentence is the api Worker's own {error} sentence (docs/api.md), when the body carried one.
func (e *Error) Sentence() string {
	var decoded struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(e.Body)), &decoded); err != nil {
		return ""
	}
	return decoded.Error
}

// RequestDeviceCode starts a device sign-in (POST /v1/device/code).
func (c *Client) RequestDeviceCode(deviceName string) (DeviceCode, error) {
	var code DeviceCode
	if err := c.post(deviceCodePath, map[string]string{"name": deviceName}, &code); err != nil {
		return DeviceCode{}, err
	}
	if code.UserCode == "" || code.DeviceCode == "" || code.VerificationURI == "" {
		return DeviceCode{}, wrapFail("api-answer", nil)
	}
	return code, nil
}

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
	var apiErr *Error
	if errors.As(err, &apiErr) && strings.Contains(apiErr.Status, "400") {
		return result, wrapFail("sign-in-expired", nil)
	}
	return result, wrapFail(FailureKind(err), err)
}

// MintKey asks the api Worker for one key of a kind (POST /v1/keys).
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

// RevokeKey cuts a key off server-side (DELETE /v1/keys/<keyId>).
func (c *Client) RevokeKey(keyID string) error {
	return c.do(http.MethodDelete, keysPath+"/"+url.PathEscape(keyID), nil, nil)
}

// RenewedKey is POST /v1/keys/<keyId>/renew's answer: the key's public row after the restart.
type RenewedKey struct {
	KeyID        string             `json:"keyId"`
	Name         string             `json:"name"`
	Kind         string             `json:"kind"`
	Capabilities []string           `json:"capabilities"`
	ExpiresAt    *int64             `json:"expiresAt"`
	Credential   *RenewedCredential `json:"credential,omitempty"`
}

// RenewedCredential is the storage pair POST /v1/keys/<id>/renew hands back when the renewal minted a fresh session under the same row id.
type RenewedCredential struct {
	AccessKeyID  string `json:"accessKeyId"`
	Secret       string `json:"secret"`
	SessionToken string `json:"sessionToken"`
	ExpiresIn    int    `json:"expiresIn"`
	ExpiresAt    int64  `json:"expiresAt"`
}

// RenewKey restarts the hour on one of this device's keys (POST /v1/keys/<keyId>/renew, issue #106).
func (c *Client) RenewKey(keyID string) (RenewedKey, error) {
	var renewed RenewedKey
	if err := c.do(http.MethodPost, keysPath+"/"+url.PathEscape(keyID)+"/renew", nil, &renewed); err != nil {
		return RenewedKey{}, err
	}
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

// RenewDeviceKey re-mints this device's storage session under the same row id (POST /v1/keys/<keyId>/renew, drive#749).
func (c *Client) RenewDeviceKey(keyID string) (RenewedKey, error) {
	var renewed RenewedKey
	if err := c.do(http.MethodPost, keysPath+"/"+url.PathEscape(keyID)+"/renew", nil, &renewed); err != nil {
		return RenewedKey{}, err
	}
	if renewed.KeyID != keyID || renewed.Kind != "device" {
		return RenewedKey{}, errors.New("the api Worker answered about a different key; run `drive login` again in a moment")
	}
	if renewed.Credential == nil || renewed.Credential.AccessKeyID == "" || renewed.Credential.Secret == "" {
		return RenewedKey{}, errors.New("the api Worker sent no fresh credential; run `drive login` again in a moment")
	}
	if renewed.ExpiresAt == nil && renewed.Credential.ExpiresAt > 0 {
		at := renewed.Credential.ExpiresAt
		renewed.ExpiresAt = &at
	}
	if renewed.ExpiresAt == nil {
		return RenewedKey{}, errors.New("the api Worker sent no expiry for the key; run `drive login` again in a moment")
	}
	if *renewed.ExpiresAt <= time.Now().Unix() {
		return RenewedKey{}, errors.New("the api Worker sent an expiry that has already passed; run `drive login` again in a moment")
	}
	return renewed, nil
}

// ClearQueueReport drops this device's live upload-queue row so a 15-minute freshness window cannot show a ghost queue after logout.
func (c *Client) ClearQueueReport() error {
	return c.do(http.MethodDelete, queueReportPath, nil, nil)
}

// RevokeDeviceToken revokes this device's own signed-in token (DELETE /v1/device/token).
func (c *Client) RevokeDeviceToken() error {
	resp, err := c.DoRaw(http.MethodDelete, deviceTokenPath, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return &Error{Method: "DELETE", Path: deviceTokenPath, Status: resp.Status, Body: string(raw)}
	}
	return nil
}

// RevokeAllKeys signs the account out of every device at once (DELETE /v1/keys).
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

// DoRaw is like do but returns the raw HTTP response without trying to unmarshal a body.
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

// Credentials is what a signed-in device keeps on disk: the one api base this device signed in to, and the device token it signs in with.
type Credentials struct {
	APIBase        string `json:"apiBase"`
	DeviceToken    string `json:"deviceToken"`
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
	KeyExpiresAt   int64  `json:"keyExpiresAt,omitempty"`
	KeyTTLSeconds  int64  `json:"keyTtlSeconds,omitempty"`
	Device         string `json:"device,omitempty"`
}

// CredentialsPath is the signed-in device's own file.
func CredentialsPath(home string) string {
	return filepath.Join(login.DefaultConfigDir(home), "credentials.json")
}

// LoadCredentials reads the signed-in device's credentials.
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
		return Credentials{}, wrapFail("credentials-unreadable", err, path)
	}
	return creds, nil
}

// SaveCredentials writes the credentials 0600 through the atomic writer, so a half-written file can never leave a device that cannot sign in.
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
