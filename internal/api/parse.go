package api

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ParseBase checks the api Worker URL and drops its trailing slash, so the
// endpoint path is appended the same way every time.
func ParseBase(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if strings.ContainsAny(trimmed, "\r\n\x00") {
		return "", errors.New("api Worker URL is not a working http or https URL")
	}
	u, err := url.Parse(trimmed)
	if err != nil {
		if inner := errors.Unwrap(err); inner != nil {
			return "", fmt.Errorf("api Worker URL does not parse: %v", inner)
		}
		return "", errors.New("api Worker URL does not parse")
	}
	if u.User != nil {
		return "", errors.New("api Worker URL carries credentials; the key is sent in the Authorization header, not in the URL")
	}
	if u.Opaque != "" {
		return "", errors.New("api Worker URL does not name a host")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("api Worker URL must be http or https")
	}
	if u.Host == "" {
		return "", errors.New("api Worker URL has no host")
	}
	if u.Scheme == "http" && !loopbackHost(u.Hostname()) {
		return "", fmt.Errorf("api Worker URL must be https://%s ...; plain http carries the storage secret in the clear", u.Host)
	}
	return strings.TrimSuffix(trimmed, "/"), nil
}

func parseAPIBase(raw string) (string, error) { return ParseBase(raw) }

func loopbackHost(host string) bool {
	if strings.EqualFold(strings.Trim(host, "[]"), "localhost") {
		return true
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func FailureKind(err error) string {
	var apiErr *Error
	if errors.As(err, &apiErr) {
		if strings.Contains(apiErr.Status, "401") || strings.Contains(apiErr.Status, "403") {
			return "key-revoked"
		}
		return "api-refused"
	}
	return "offline"
}
