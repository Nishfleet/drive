package main

import (
	"fmt"
	"strconv"
	"time"
)

// Background fill: the rest of a file after the first bytes (drive issue
// #194). Nothing here moves bytes. Every rule is a stock rclone option, and
// the mount already carries the cache that holds the filled-in bytes, so the
// fill is rclone fetching the next chunk it was always going to fetch, only
// without waiting for a foreground read to ask for it.
//
// Two stock options are this file's own:
//
//   - --vfs-read-chunk-size-limit doubles the chunk size after each chunk
//     read, up to the limit, so a file nobody ever reaches the end of is not
//     fetched 128 MiB at a time for the whole 10 GB, and a file somebody does
//     reach the end of arrives in a few large requests instead of many small
//     ones. Measured in cmd/drive's own test (TestBackgroundFillChunkSize) and
//     on the mount in e2e_test.go's open-time proof.
//   - --vfs-cache-max-age decides how long a file somebody opened stays: it is
//     time since last access, so it is what makes "recently opened files stay
//     on the disk" true rather than a second index this product would have to
//     keep.
//
// --vfs-read-ahead is the first chunk an open file fetches. It was already on
// the mount before the fill, as one of the hill-climb's (issue #248) tunables,
// and it stays exactly that: the fill policy below reports the mount's shipped
// value (vfsReadAheadValue) rather than carrying a second one, so the product
// has one read-ahead number and a person tuning it tunes the mount.
//
// The cap is not a fill rule and is not repeated here: --vfs-cache-max-size
// (vfsCacheMaxValue) is already on the mount, and rclone checks it on every
// cache poll, so background fill cannot push the cache past the user's cap.
// TestBackgroundFillFillsThroughTheCappedCache proves that on a real mount
// rather than asserting it.

// fillChunkSizeLimit is the ceiling on rclone's own chunk doubling. rclone
// reads 128M (its default) for the first chunk and doubles for each chunk
// after, so a 10 GB file is fetched as 128M, 256M, 512M, 1G, 1G... With the
// limit at 1G the tail of a big file arrives in far fewer requests than the
// default and the cache holds the same bytes.
//
// The limit is a ceiling, not a size: the doubling only ever runs on a file
// that is still being read, and only up to the file's own end. Measured in
// TestBackgroundFillChunkSize.
const fillChunkSizeLimit = "1G"

// fillMaxAge is how long a file somebody opened stays in the cache after its
// last access. It is what "recently opened files stay on the disk" means with
// no second index: rclone's own poll evicts by last access time, so the fill
// a background loop left behind is kept for a person to come back to, and
// then dropped on the same clock as everything else in the cache. 24h is
// longer than the 1h rclone ships with, because a file a person opened
// yesterday evening is one they open again this morning.
//
// The cap still holds over any age: --vfs-cache-max-size evicts before
// --vfs-cache-max-age does, on the same poll
// (TestBackgroundFillFillsThroughTheCappedCache).
const fillMaxAge = "24h"

// fillIdleCheck is the interval the background loop asks rclone's remote
// control whether the machine is idle, and how long it waits between two
// checks. It is the loop's own clock, not a cache setting: nothing in rclone
// decides when the fill runs, only what it does when it runs.
const fillIdleCheck = 30 * time.Second

// vfsChunkSizeLimit and vfsMaxAge are the mount flags above, named once so
// the fill loop and the mount cannot drift on the spelling.
func vfsChunkSizeLimit() string { return fillChunkSizeLimit }
func vfsMaxAge() string         { return fillMaxAge }

// FillPolicy is what the background fill does, in one value the mount and
// `drive status` can both read. It is deliberately a description of stock
// rclone settings, not a scheduler: the loop in fill_run.go only decides
// *when* to let rclone read ahead. ReadAhead is the mount's shipped first
// chunk (vfsReadAheadValue), reported here so one value is read in three
// places rather than three values being kept.
type FillPolicy struct {
	ReadAhead      string
	ChunkSizeLimit string
	MaxAge         string
	IdleCheck      time.Duration
}

// DefaultFillPolicy is the policy the mount carries. It is exported so the
// mount, the status line and the tests read one value.
func DefaultFillPolicy() FillPolicy {
	return FillPolicy{
		ReadAhead:      vfsReadAheadValue,
		ChunkSizeLimit: fillChunkSizeLimit,
		MaxAge:         fillMaxAge,
		IdleCheck:      fillIdleCheck,
	}
}

// ShouldFill reports whether the background fill runs right now. It is one
// function with no hidden inputs so the rules in the issue are testable
// without a mount:
//
//   - a folder kept offline (#115) is filled in full, whatever the load
//     average, because the person said the whole copy must be there before
//     they fly;
//   - otherwise the fill runs only when the machine is idle, so it can never
//     compete with the app a person is actually using.
//
// A pinned folder is listed in Offline, so a person who pinned something gets
// it filled even on a busy machine; that is the promise they were given, and
// the cost is the bytes, not their foreground speed (the cap still holds).
func ShouldFill(offline bool, load1, load5 float64) bool {
	if offline {
		return true
	}
	return load1 < idleLoad && load5 < idleLoad
}

// idleLoad is the one-minute and five-minute load average below which this
// host is idle enough for a background fill. 1.0 is one runnable process's
// worth of work on a single core: a person reading a document on this machine
// is not there. 0.6 leaves room for the browser and the video player a
// foreground open is competing with, so the fill yields rather than compete.
const idleLoad = 0.6

// FormatBytes renders a byte count the way `drive status` and the fill line
// read it, so a cache-size number in the CLI, in the fill report and in the
// docs are one format.
func FormatBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit && exp < 4; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTP"[exp])
}

// parseSizeSuffix reads rclone's own SizeSuffix values (1M, 512M, 2G, 10G,
// 1.5G) into bytes, so a flag the CLI sets and a number the fill loop reports
// are the same unit. It is the parser for the handful of forms the product
// sets and the cap test uses; rclone itself accepts the rest.
func parseSizeSuffix(s string) (int64, error) {
	trimmed := s
	mult := int64(1)
	for _, suffix := range []struct {
		name string
		m    int64
	}{
		{"k", 1 << 10}, {"m", 1 << 20}, {"g", 1 << 30}, {"t", 1 << 40}, {"p", 1 << 50},
	} {
		if len(trimmed) > 0 && (trimmed[len(trimmed)-1] == suffix.name[0] || trimmed[len(trimmed)-1] == suffix.name[0]-32) {
			mult = suffix.m
			trimmed = trimmed[:len(trimmed)-1]
			break
		}
	}
	// rclone's own rule: a bare number is bytes, a decimal is a multiple.
	if i := len(trimmed); i > 0 {
		if v, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
			return v * mult, nil
		}
		f, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return 0, fmt.Errorf("size %q: %w", s, err)
		}
		return int64(f * float64(mult)), nil
	}
	return 0, fmt.Errorf("size %q: no number", s)
}
