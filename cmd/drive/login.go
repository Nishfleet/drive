package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// defaultAPIBase is the one host that fronts both /api/* and /v1/* (drive#156).
// It matches src/seo.js SITE_ORIGIN; TestDefaultAPIBaseMatchesTheShippedSite
// fails if they drift. --api and DRIVE_API_URL still win.
const defaultAPIBase = "https://drive-pricing.nishant345.workers.dev"

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

// envDeviceName is the device name this process carries: --device, which
// `drive init` and `drive mount` put into DRIVE_DEVICE, else the
// hostname with a stock-name suffix. Sign-in answers to the same name
// the mount's conflict copies carry, so one device is one name.
func envDeviceName() string {
	return deviceName(os.Getenv(deviceEnvName), osHostname())
}

// Login is `drive login`: device sign-in, mint this device's key, write the
// storage settings so `drive init` and `drive mount` need no pasted keys.
// `device` names this device at sign-in — --device when the person gave
// one, else the hostname, with a short machine suffix when the hostname
// is a stock model name two Macs would share (issue #561).
func Login(home, apiBase, device string, out io.Writer) error {
	if strings.TrimSpace(apiBase) == "" {
		return fail("no-api")
	}
	client, err := NewAPIClient(apiBase, "")
	if err != nil {
		return err
	}
	name := deviceName(device, osHostname())
	token, account, err := SignIn(client, name, out)
	if err != nil {
		return err
	}
	client.Token = token
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
		APIBase:      client.Base,
		DeviceToken:  token,
		AccountID:    account.ID,
		AccountName:  account.Name,
		AccountEmail: account.Email,
		Endpoint:     cfg.Endpoint,
		Bucket:       cfg.Bucket,
		Prefix:       cfg.Prefix,
		Region:       cfg.Region,
		AccessKeyID:  cfg.AccessKey,
		KeyID:        key.KeyID,
	}
	if err := SaveCredentials(home, creds); err != nil {
		return err
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		return err
	}
	if err := WriteRcloneEnv(home, cfg, "", ""); err != nil {
		return err
	}
	who := accountLabel(account)
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
	device := fs.String("device", "", "name this device is called in the account (default: the hostname, with a suffix when it is a stock model name)")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return usageFailure(usage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	return Login(common.home, *api, *device, os.Stdout)
}
