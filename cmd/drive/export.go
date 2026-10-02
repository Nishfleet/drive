// `drive export` (drive issue #34, "Account lifecycle: export"): the account's
// own data as one JSON document, straight from the api Worker's GET /v1/export
// (workers/api/src/export-routes.js). The route is the gate; this command is
// the caller that puts the document where a person can keep it.
//
// The bytes of each file are the file half of the export and are not fetched
// here: the export route names every file's path and size, and the bytes are
// read through the mount or the dl Worker, which is the path that already
// counts downloads. This command is the account-data half, the one a person
// needs to keep off our servers, and it is the caller the issue's "export all
// files and account data" needs the route to have.

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

// EXPORT_PATH is the api Worker's own-data export endpoint
// (workers/api/src/export-routes.js). One path, named in one place, so it
// cannot drift from the route it calls.
const EXPORT_PATH = "/v1/export"

// exportMaxPages bounds the walk over a drive's pages. A page carries
// EXPORT_ROW_CAP rows (5000), so this is a drive with far more rows than any
// real account reaches; it is here so a server that never reports completion
// ends the command with a named error instead of holding a terminal open.
const exportMaxPages = 1000

// exportCursorText renders a file cursor for the "did not finish" error, or a
// dash when there is none.
func exportCursorText(cursor *string) string {
	if cursor == nil {
		return "-"
	}
	return *cursor
}

// exportVersionCursorText renders the version cursor for the "did not finish"
// error, or a dash when there is none.
func exportVersionCursorText(document ExportDocument) string {
	if document.Next.VersionCursor == nil {
		return "-"
	}
	return fmt.Sprintf("%d/%s", document.Next.VersionCursor.At, document.Next.VersionCursor.ID)
}

// ExportDocument is the account's own data as the route returns it: the
// account row, its keys, the file index and the version history. The field
// names are the route's own JSON keys.
//
// The nullable time fields are pointers, not zero values: a key never seen
// (`lastSeenAt`) and a version not yet hidden (`hiddenAt`) are real states
// that must not read as an epoch instant in the saved document.
type ExportDocument struct {
	GeneratedAt string          `json:"generatedAt"`
	Account     ExportAccount   `json:"account"`
	Keys        []ExportKey     `json:"keys"`
	Files       []ExportFile    `json:"files"`
	Versions    []ExportVersion `json:"versions"`
	// Complete is the route's own word for "this page is the whole drive". A
	// false here means the drive holds more rows than one response can carry,
	// and Next carries the cursors that continue it.
	Complete bool `json:"complete"`
	Next     struct {
		FileCursor    *string              `json:"fileCursor"`
		VersionCursor *ExportVersionCursor `json:"versionCursor"`
	} `json:"next"`
}

// ExportVersionCursor is the position the version page stopped at: the
// created_at of its last row and that row's b2_file_id, which together break
// the ties between versions written in the same millisecond. A nil cursor on
// the document means this was the last version page.
type ExportVersionCursor struct {
	At int64  `json:"at"`
	ID string `json:"id"`
}

// ExportAccount is the account the export is about.
type ExportAccount struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// ExportKey is one of the account's keys as the export carries it. There is
// no secret field: the api Worker keeps only a hash, so there is none to
// return (export-routes.js).
type ExportKey struct {
	KeyID        string   `json:"keyId"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Prefix       string   `json:"prefix"`
	Capabilities []string `json:"capabilities"`
	CreatedAt    int64    `json:"createdAt"`
	LastSeenAt   *int64   `json:"lastSeenAt"`
	RevokedAt    *int64   `json:"revokedAt"`
}

// ExportFile is one row of the account's file-name index.
type ExportFile struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	Parent     string  `json:"parent"`
	SizeBytes  int64   `json:"sizeBytes"`
	ModifiedAt *string `json:"modifiedAt"`
	IndexedAt  *string `json:"indexedAt"`
}

// ExportVersion is one row of the account's version history, the same
// file_versions table the meter bills from.
type ExportVersion struct {
	B2FileID  string `json:"b2FileId"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt int64  `json:"createdAt"`
	HiddenAt  *int64 `json:"hiddenAt"`
	DeletedAt *int64 `json:"deletedAt"`
}

// runExport is `drive export [--out <file>]`: fetch the signed-in account's own
// data and write it where the person asked. With no --out the document goes to
// stdout, so `drive export > account.json` works with no flag at all.
func runExport(args []string) error {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	common := addCommonFlags(fs)
	out := fs.String("out", "", "write the export to this file instead of stdout")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	// The device token is the whole credential for the account gate, so the
	// export reads it from the credentials `drive init` wrote — never from a
	// flag, because an argument is visible in `ps` output and the shell
	// history (the same rule cmd/drive/config.go keeps the storage keys to).
	creds, err := LoadCredentials(common.home)
	if err != nil {
		return err
	}
	if creds.DeviceToken == "" || creds.APIBase == "" {
		return fmt.Errorf("this machine is not signed in; run `drive init` first")
	}
	document, err := fetchExport(creds.APIBase, creds.DeviceToken)
	if err != nil {
		return err
	}
	// The document is written from the route's own fields, so what a person
	// keeps is the server's account data rather than this command's rendering
	// of it. 0600, like every other file the CLI writes with credentials in
	// it: the export names the account's keys and folders.
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the export: %w", err)
	}
	raw = append(raw, '\n')
	summary := fmt.Sprintf("%d file(s) and %d key(s) for %s",
		len(document.Files), len(document.Keys), exportAccountLabel(document.Account))
	if *out == "" {
		if _, err := os.Stdout.Write(raw); err != nil {
			return fmt.Errorf("write the export to stdout: %w", err)
		}
		fmt.Fprintln(os.Stderr, "exported "+summary)
		return nil
	}
	if err := WriteFileAtomic(*out, raw, 0o600); err != nil {
		return err
	}
	fmt.Printf("wrote %s: %s\n", *out, summary)
	return nil
}

// exportAccountLabel names the account in the summary line, preferring the
// address (the thing a person recognises) and falling back to the account id
// when the sign-in flow recorded no address.
func exportAccountLabel(account ExportAccount) string {
	if account.Email != "" {
		return account.Email
	}
	if account.Name != "" {
		return account.Name
	}
	return account.ID
}

// fetchExport walks the api Worker's export route and returns the whole
// document. Every non-2xx is a named error carrying the Worker's own sentence
// (the api's {"error"} shape, cmd/drive/api.go `APIError`), never a quiet empty
// document: an empty export that reads as "you have no files" is the one wrong
// answer this command could give.
//
// The route is a bounded page (workers/api/src/export-routes.js
// `EXPORT_ROW_CAP`), so a drive larger than one page is walked here, cursor by
// cursor, and the files and versions of every page are merged into the one
// document the person saves. A page is only merged once it has been read, so a
// failure part way through returns an error and writes nothing: half an export
// that looks whole is worse than none.
func fetchExport(apiBase, deviceToken string) (*ExportDocument, error) {
	client, err := NewAPIClient(apiBase, deviceToken)
	if err != nil {
		return nil, err
	}
	var document ExportDocument
	if err := client.do(http.MethodGet, exportPagePath("", nil), nil, &document); err != nil {
		return nil, err
	}
	if document.Account.ID == "" {
		return nil, fmt.Errorf("GET %s%s answered without an account; run `drive init` again",
			client.Base, EXPORT_PATH)
	}
	for pages := 0; !document.Complete; pages++ {
		if pages >= exportMaxPages {
			// A server that keeps asking for a page would hold a hung
			// terminal, so the walk is bounded and the last page is kept
			// rather than thrown away: what was read is still the account's
			// own data, and the error says exactly where it stopped.
			return nil, fmt.Errorf("the export did not finish within %d pages (%d file(s), %d version(s)); "+
				"the last page ended at file cursor %q, version cursor %s",
				exportMaxPages, len(document.Files), len(document.Versions),
				exportCursorText(document.Next.FileCursor), exportVersionCursorText(document))
		}
		fileCursor := ""
		if document.Next.FileCursor != nil {
			fileCursor = *document.Next.FileCursor
		}
		var page ExportDocument
		if err := client.do(http.MethodGet, exportPagePath(fileCursor, document.Next.VersionCursor), nil, &page); err != nil {
			return nil, fmt.Errorf("continue the export after %d file(s): %w", len(document.Files), err)
		}
		document.Files = append(document.Files, page.Files...)
		document.Versions = append(document.Versions, page.Versions...)
		// The keys are not paged: the route reads the account's whole key
		// list on every page, so merging them again would double them in the
		// saved document. The account row and the generated-at stamp are the
		// first page's, and only the cursor and the completion flag move.
		document.Complete = page.Complete
		document.Next = page.Next
	}
	return &document, nil
}

// exportPagePath is GET /v1/export with the cursors a previous page ended on.
// The file cursor is a string and the version cursor is a pointer, so "no
// cursor" is a real state in both and never a value that happens to be on
// this account's first row (a zero `versionAt` would be read as `created_at >
// 0`, which re-reads every version and double-counts it across pages). The
// first page carries no query at all.
//
// @param {string} fileCursor
// @param {ExportVersionCursor|null|undefined} versionCursor
func exportPagePath(fileCursor string, versionCursor *ExportVersionCursor) string {
	params := url.Values{}
	if fileCursor != "" {
		params.Set("fileCursor", fileCursor)
	}
	if versionCursor != nil {
		params.Set("versionAt", fmt.Sprintf("%d", versionCursor.At))
		if versionCursor.ID != "" {
			params.Set("versionId", versionCursor.ID)
		}
	}
	if len(params) == 0 {
		return EXPORT_PATH
	}
	return EXPORT_PATH + "?" + params.Encode()
}
