package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// CAP_PATH is the pricing Worker's spending-cap write (core/cap.js `handleCapRequest`).
const CAP_PATH = "/api/cap"

// CapAnswer is POST /api/cap's body: the new cap line `drive status` will print, whether the mount has to restart so rclone picks up a swapped key, and — when a key was actually swapped — the credential that replaced it.
type CapAnswer struct {
	CapLine    string          `json:"capLine"`
	Error      string          `json:"error"`
	Credential *SwapCredential `json:"credential"`
	Mount      struct {
		Restart bool    `json:"restart"`
		Reason  *string `json:"reason"`
	} `json:"mount"`
}

// SwapCredential is the credential a cap swap minted, in the shape the rclone config signs with.
type SwapCredential struct {
	AccessKeyID  string `json:"accessKeyId"`
	Secret       string `json:"secret"`
	SessionToken string `json:"sessionToken"`
}

func runCap(args []string) error {
	fs := flag.NewFlagSet("cap", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	amount := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if amount == "" {
		return fmt.Errorf("a spending cap is a dollar amount like 20 or 12.50. Run: drive cap 20")
	}
	home := common.home
	client, err := signedInClient(home, *api, os.Stdout)
	if err != nil {
		return err
	}
	var answer CapAnswer
	if err := client.Post(CAP_PATH, map[string]string{"amount": amount}, &answer); err != nil {
		return err
	}
	if strings.TrimSpace(answer.CapLine) != "" {
		fmt.Println(answer.CapLine)
	}
	if !answer.Mount.Restart {
		return nil
	}
	rcloneBin, err := ResolveRclone(common.rclone)
	if err != nil {
		return err
	}
	if cred := answer.Credential; cred != nil && cred.AccessKeyID != "" && cred.Secret != "" {
		cfg, err := LoadStorageConfig("", "", "", "", "", cred.Secret, storageFromDisk(home))
		if err != nil {
			return fmt.Errorf("restart the mount: %w", err)
		}
		cfg.AccessKey = cred.AccessKeyID
		cfg.SessionToken = cred.SessionToken
		if err := checkConfigValue("access key", cfg.AccessKey); err != nil {
			return fmt.Errorf("restart the mount: %w", err)
		}
		if err := checkConfigValue("session token", cfg.SessionToken); err != nil {
			return fmt.Errorf("restart the mount: %w", err)
		}
		return RestartMount(CurrentGOOS(), home, rcloneBin, cfg)
	}
	secretKey, err := ReadSecretKey(RcloneConfigPath(home), false, os.Stdin)
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	cfg, err := LoadStorageConfig("", "", "", "", "", secretKey, storageFromDisk(home))
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	return RestartMount(CurrentGOOS(), home, rcloneBin, cfg)
}
