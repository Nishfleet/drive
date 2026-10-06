package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/Nishfleet/drive/internal/api"
	"github.com/Nishfleet/drive/internal/atomicwrite"
	"github.com/Nishfleet/drive/internal/httpclient"
	"github.com/Nishfleet/drive/internal/login"
	"github.com/Nishfleet/drive/internal/rc"
)

func init() {
	api.OpenURL = func(s string) error { return openURL(s) }
	api.SetFail(func(kind string, detail error, args ...string) error {
		f := failDetail(kind, detail, args...)
		if detail != nil {
			var apiErr *api.Error
			if errors.As(detail, &apiErr) {
				if s := apiErr.Sentence(); s != "" {
					f = f.withService(s)
				}
			}
		}
		return f
	})
}

func newHTTPClient(timeout time.Duration) *http.Client {
	return httpclient.New(timeout)
}

func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	return atomicwrite.Write(path, data, mode)
}

// ---- api client (internal/api) ----

type APIClient = api.Client
type APIError = api.Error
type DeviceCode = api.DeviceCode
type MintedKey = api.MintedKey
type Account = api.Account
type Credentials = api.Credentials
type RenewedKey = api.RenewedKey

const (
	deviceCodePath  = api.DeviceCodePath
	deviceTokenPath = api.DeviceTokenPath
	keysPath        = api.KeysPath
	queueReportPath = api.QueueReportPath
)

func NewAPIClient(apiBase, token string) (*APIClient, error) {
	return api.New(apiBase, token)
}

func SignIn(client *APIClient, deviceName string, out io.Writer) (string, Account, error) {
	return api.SignIn(client, deviceName, out)
}

func CredentialsPath(home string) string { return api.CredentialsPath(home) }
func LoadCredentials(home string) (Credentials, error) {
	return api.LoadCredentials(home)
}
func SaveCredentials(home string, creds Credentials) error {
	return api.SaveCredentials(home, creds)
}

// ---- login items (internal/login) ----

type StorageConfig = login.StorageConfig
type RCAuth = login.RCAuth

const (
	RcloneRemoteName     = login.RcloneRemoteName
	secretEnvName        = login.SecretEnvName
	rcloneRCUserEnv      = login.RCUserEnv
	rcloneRCPassEnv      = login.RCPassEnv
	rcloneSecretEnv      = login.SecretEnv
	rcloneDownloadURLEnv = login.DownloadURLEnv
	maxSecretBytes       = login.MaxSecretBytes
)

func DefaultConfigDir(home string) string { return login.DefaultConfigDir(home) }
func DefaultMountDir(home string) string  { return login.DefaultMountDir(home) }
func DefaultCacheDir(home string) string  { return login.DefaultCacheDir(home) }
func RcloneConfigPath(home string) string { return login.RcloneConfigPath(home) }
func RcloneEnvPath(home string) string    { return login.RcloneEnvPath(home) }
func RcloneConfig(c StorageConfig) string { return login.RcloneConfig(c) }
func RcloneConfigRedacted(c StorageConfig) string {
	return login.RcloneConfigRedacted(c)
}
func WriteRcloneEnv(home string, c StorageConfig, rcUser, rcPass string) error {
	return login.WriteRcloneEnv(home, c, rcUser, rcPass)
}
func ReadRCAuth(home string) (RCAuth, error) { return login.ReadRCAuth(home) }
func ReadSecretKey(configPath string, wantStdin bool, stdin io.Reader) (string, error) {
	return login.ReadSecretKey(configPath, wantStdin, stdin)
}
func ParseRcloneConfig(path string) (StorageConfig, error) {
	return login.ParseRcloneConfig(path)
}
func rcloneEnvPathBeside(configPath string) string { return login.EnvPathBeside(configPath) }
func secretFromEnvFile(path string) (string, error) {
	return login.SecretFromEnvFile(path)
}

// ---- rclone helper (internal/rc) ----

type rcClient struct{ *rc.Client }
type vfsStats = rc.VFSStats
type queueEntry = rc.QueueEntry
type BwLimit = rc.BwLimit
type QueueItem = rc.QueueItem
type Queue = rc.Queue
type Transfer = rc.Transfer
type Stats = rc.Stats

const (
	pausedRate         = "1KiB:off"
	rclonePausedRate   = "1Ki:off"
	resumeRate         = "off"
	queueHoldExpiry    = "1000000000"
	queueReleaseExpiry = "-1000000000"
	rcTimeout          = 30 * time.Second
)

func rcCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), rcTimeout)
}

func newRCClient(binary, addr, fs string) *rcClient {
	return &rcClient{Client: rc.New(binary, addr, fs)}
}

func (c *rcClient) call(ctx context.Context, method string, params map[string]string, out any) error {
	return c.Call(ctx, method, params, out)
}
func (c *rcClient) stats(ctx context.Context) (vfsStats, error) { return c.Stats(ctx) }
func (c *rcClient) refresh(ctx context.Context, recursive bool) error {
	return c.Refresh(ctx, recursive)
}
func (c *rcClient) remote() string { return c.Remote() }
func (c *rcClient) queue(ctx context.Context) ([]queueEntry, error) {
	return c.Queue(ctx)
}
func (c *rcClient) remoteHas(ctx context.Context, name string) (bool, error) {
	return c.RemoteHas(ctx, name)
}
func (c *rcClient) remoteHash(ctx context.Context, name string) (string, error) {
	return c.RemoteHash(ctx, name)
}
func (c *rcClient) remoteVersion(ctx context.Context, name string) (int64, time.Time, bool, error) {
	return c.RemoteVersion(ctx, name)
}
func (c *rcClient) copyLocalToRemote(ctx context.Context, stagingRoot, srcRemote, dstRemote string) error {
	return c.CopyLocalToRemote(ctx, stagingRoot, srcRemote, dstRemote)
}
func (c *rcClient) cacheOutOfSpace(ctx context.Context) (bool, error) {
	return c.CacheOutOfSpace(ctx)
}
func (c *rcClient) cacheStats(ctx context.Context) (vfsStats, error) {
	return c.CacheStats(ctx)
}

func PauseStatePath(home string) string { return rc.PauseStatePath(home) }
func SetPaused(home string) error       { return rc.SetPaused(home) }
func ClearPaused(home string) error     { return rc.ClearPaused(home) }
func PausedRate(home string) string     { return rc.PausedRate(home) }
func Paused(home string) bool           { return rc.Paused(home) }
func rateIsPaused(rate string) bool     { return rc.RateIsPaused(rate) }
func matchHashSum(lines []string, name string) (string, error) {
	return rc.MatchHashSum(lines, name)
}
func sameVersion(size int64, modTime time.Time, stagedSize int64, stagedMtime time.Time) bool {
	return rc.SameVersion(size, modTime, stagedSize, stagedMtime)
}

func mountRCClient(home string) (*rcClient, error) {
	binary, err := ResolveRclone("")
	if err != nil {
		return nil, fmt.Errorf("rclone: %w", err)
	}
	c := newRCClient(binary, RCAddr(), "")
	auth, err := ReadRCAuth(home)
	if err != nil {
		return nil, fmt.Errorf("rclone rc auth: %w", err)
	}
	c.SetAuth(auth.User, auth.Pass)
	return c, nil
}
