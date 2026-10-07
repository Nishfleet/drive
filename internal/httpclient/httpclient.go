package httpclient

import (
	"net/http"
	"time"
)

// New returns the one HTTP client constructor this CLI uses: a client
// bounded by timeout, so a Worker or page that never answers fails with
// a sentence rather than hanging the terminal.
//
// Callers that send a storage secret in Authorization (revoke) set
// CheckRedirect on the returned client so Go does not replay that header
// onto a 3xx. Other callers match their previous timeout-only client.
func New(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout}
}
