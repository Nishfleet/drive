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

func deviceName() string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return "this device"
	}
	return name
}

// Login is `drive login`: device sign-in, mint this device's key, write the
// storage settings so `drive init` and `drive mount` need no pasted keys.
func Login(home, apiBase string, out io.Writer) error {
	if strings.TrimSpace(apiBase) == "" {
		return fail("no-api")
	}
	client, err := NewAPIClient(apiBase, "")
	if err != nil {
		return err
	}
	token, err := SignIn(client, deviceName(), out)
	if err != nil {
		return err
	}
	client.Token = token.Token
	previous, loadErr := LoadCredentials(home)
	if loadErr != nil {
		// An unreadable credentials file is not a previous key we can
		// revoke. Login still mints; the new file replaces the broken one.
		previous = Credentials{}
	}
	key, err := client.MintKey("device", deviceName())
	if err != nil {
		return err
	}
	// A device key is the one credential the CLI stores and never renews:
	// there is no `drive key renew` for a device kind (issue #106 renews an
	// agent key only), and the login task re-runs the mount with the key it
	// was given rather than minting a new one. A provider that names a session
	// of its own (the STS path, issue #462) is now recorded on the key's row
	// (drive#544), so a device mint can answer with an hour on it, and storing
	// one would leave storage settings on disk that stop signing requests an
	// hour later, with `drive status` still reporting a mount that is not
	// uploading. Refuse before anything is written: the files on disk stay the
	// ones that worked.
	if key.ExpiresAt != nil {
		return failf("device-key-expiring", expiryLabel(key.ExpiresAt))
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
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return usageFailure(usage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	return Login(common.home, *api, os.Stdout)
}
