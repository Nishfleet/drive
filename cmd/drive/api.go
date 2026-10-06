package main

import (
	"strings"
)

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
