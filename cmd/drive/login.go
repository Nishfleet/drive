package main

import (
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// siteAddress is the one place the site's address is written (drive#527). It
// sits in this package because Go's //go:embed cannot reach outside its own
// directory, and core/seo.js and docs-site/.vitepress/config.mts import the
// same file, so a domain move is one edit here and not a sweep of ten files.
//
//go:embed site.json
var siteAddress []byte

// defaultAPIBase is the one host that fronts both /api/* and /v1/* (drive#156).
// It is the embedded site address, so the CLI and the site cannot drift.
// --api and DRIVE_API_URL still win. A site.json that does not parse is a
// build mistake, and a binary built from one fails loudly rather than sending
// a customer to a host nobody chose.
var defaultAPIBase = mustSiteOrigin()

/** The origin field of the embedded site address. */
func mustSiteOrigin() string {
	var site struct {
		Origin string `json:"origin"`
	}
	if err := json.Unmarshal(siteAddress, &site); err != nil {
		panic("drive: site.json is not valid JSON: " + err.Error())
	}
	if !strings.HasPrefix(site.Origin, "https://") {
		panic("drive: site.json origin must be an https address, got " + site.Origin)
	}
	return site.Origin
}

// openURL opens the device-approve page. Tests replace it so the stand-in
// never needs a display.
var openURL = openBrowser

func openBrowser(raw string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", raw).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", raw).Start()
	default:
		return exec.Command("xdg-open", raw).Start()
	}
}

// deviceName is the name this device answers by at sign-in: the name
// the person gave (--device), else the hostname — and a hostname that
// is a stock model name (a new Mac's "MacBook-Air", which every Mac
// of that model shares) carries a short machine suffix, so two such
// Macs are two devices in the account, not one (issue #561). The
// result is sanitized the way the mount sanitizes its conflict name
// (DefaultDeviceName -> SanitizeDevice), so the name the account shows
// and the name a conflict copy carries are one name.
func deviceName(flag, hostname string) string {
	if set := strings.TrimSpace(flag); set != "" {
		if name := SanitizeDevice(set); name != "" {
			return name
		}
	}
	if strings.TrimSpace(hostname) == "" {
		return "this device"
	}
	if name := SanitizeDevice(stockedHostname(hostname)); name != "" {
		return name
	}
	return "this device"
}

// osHostname is the machine's own hostname, or "" when the OS gives
// this machine none.
func osHostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

// loginDeviceName is the name this login will register: --device, else
// DRIVE_DEVICE, else the name an earlier login saved, else the hostname
// with a stock-name suffix. Sign-in, the minted key and the credentials
// file all answer to this one name (issue #561).
func loginDeviceName(flag, previous string) string {
	return deviceName(firstNonEmpty(
		strings.TrimSpace(flag),
		strings.TrimSpace(os.Getenv(deviceEnvName)),
		strings.TrimSpace(previous),
	), osHostname())
}

// envDeviceName is the device name this process carries: DRIVE_DEVICE, else
// the name `drive login --device` saved in the credentials file, else the
// hostname with a stock-name suffix. Sign-in answers to the same name
// the mount's conflict copies carry, so one device is one name.
func envDeviceName(home string) string {
	previous := ""
	if creds, err := LoadCredentials(home); err == nil {
		previous = creds.Device
	}
	return loginDeviceName("", previous)
}

// Login is `drive login`: device sign-in, mint this device's key, write the
// storage settings so `drive init` and `drive mount` need no pasted keys.
// The name at sign-in is --device, else DRIVE_DEVICE, else the name an
// earlier login saved, else the hostname, with a short machine suffix when
// that hostname is a stock model name two Macs would share (issue #561).
func Login(home, apiBase, device string, out io.Writer) error {
	if strings.TrimSpace(apiBase) == "" {
		return fail("no-api")
	}
	client, err := NewAPIClient(apiBase, "")
	if err != nil {
		return err
	}
	previous, loadErr := LoadCredentials(home)
	if loadErr != nil {
		// An unreadable credentials file is not a previous key we can
		// revoke. Login still mints; the new file replaces the broken one.
		previous = Credentials{}
	}
	name := loginDeviceName(device, previous.Device)
	token, err := SignIn(client, name, out)
	if err != nil {
		return err
	}
	client.Token = token.Token
	key, err := client.MintKey("device", name)
	if err != nil {
		return err
	}
	cfg := StorageConfig{
		Endpoint:     key.Endpoint,
		AccessKey:    key.AccessKeyID,
		SecretKey:    key.Secret,
		SessionToken: key.SessionToken,
		Bucket:       key.Bucket,
		Prefix:       key.Prefix,
		Region:       firstNonEmpty(key.Region, "us-east-1"),
		DownloadURL:  key.DownloadURL,
	}
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
		missing := []string{}
		if cfg.Endpoint == "" {
			missing = append(missing, "endpoint")
		}
		if cfg.Bucket == "" {
			missing = append(missing, "bucket")
		}
		if cfg.AccessKey == "" {
			missing = append(missing, "access key")
		}
		if cfg.SecretKey == "" {
			missing = append(missing, "secret key")
		}
		return failf("login-no-storage", strings.Join(missing, ", "))
	}
	creds := Credentials{
		APIBase:     client.Base,
		DeviceToken: token.Token,
		// The expiry the sign-in answered is written down here, where the
		// device token is written down (drive#557), so there is one place that
		// knows how long this sign-in lasts and no path that stores a token
		// without its date. A Worker that answered no expiry leaves it 0 and
		// the token is still the one that works.
		TokenExpiresAt: token.ExpiresAt,
		AccountID:      token.Account.ID,
		AccountName:    token.Account.Name,
		AccountEmail:   token.Account.Email,
		Endpoint:       cfg.Endpoint,
		Bucket:         cfg.Bucket,
		Prefix:         cfg.Prefix,
		Region:         cfg.Region,
		DownloadURL:    cfg.DownloadURL,
		AccessKeyID:    cfg.AccessKey,
		KeyID:          key.KeyID,
		// The name sign-in and the key actually used, so a later login
		// without --device registers the same device, not the hostname.
		Device: name,
	}
	if key.ExpiresAt != nil {
		creds.KeyExpiresAt = *key.ExpiresAt
	}
	if key.ExpiresIn > 0 {
		creds.KeyTTLSeconds = int64(key.ExpiresIn)
	}
	if err := SaveCredentials(home, creds); err != nil {
		return err
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		return err
	}
	if err := WriteRcloneEnv(home, cfg, "", "", ""); err != nil {
		return err
	}
	if previous.DeviceToken != "" && previous.DeviceToken != token.Token {
		// The queue row is keyed by the device token, so the old login's
		// row would count this device twice for its freshness window.
		base := previous.APIBase
		if base == "" {
			base = apiBase
		}
		old, err := NewAPIClient(base, previous.DeviceToken)
		if err == nil {
			err = old.ClearQueueReport()
		}
		if err != nil && !isAPIStatus(err, "401") && !isAPIStatus(err, "404") {
			fmt.Fprintf(out, "note: the previous login's upload queue could not be cleared (%v); it ages out in 15 minutes\n", err)
		}
	}
	if previous.KeyID != "" && previous.KeyID != key.KeyID {
		if err := client.RevokeKey(previous.KeyID); err != nil && !isAPIStatus(err, "404") {
			fmt.Fprintf(out, "note: the previous device key could not be revoked (%v); it is still live\n", err)
		}
	}
	who := accountLabel(token.Account)
	if who == "" {
		fmt.Fprintln(out, "Signed in. Storage settings written. Run `drive init` to mount.")
		return nil
	}
	fmt.Fprintf(out, "Signed in as %s. Storage settings written. Run `drive init` to mount.\n", who)
	return nil
}

func runLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	api := fs.String("api", firstNonEmpty(os.Getenv("DRIVE_API_URL"), defaultAPIBase), "api Worker base URL")
	device := fs.String("device", "", "name this device is called in the account (default: DRIVE_DEVICE, else the name a previous login saved, else the hostname, with a suffix when it is a stock model name)")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return usageFailure(usage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	return Login(common.home, *api, *device, os.Stdout)
}
