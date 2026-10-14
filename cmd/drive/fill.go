package main

import (
	"fmt"
	"strconv"
	"time"
)

// rclone reads 128M for the first chunk and doubles for each chunk after.
const fillChunkSizeLimit = "1G"

const fillMaxAge = "24h"

const fillIdleCheck = 30 * time.Second

func vfsChunkSizeLimit() string { return fillChunkSizeLimit }
func vfsMaxAge() string         { return fillMaxAge }

// FillPolicy is what the background fill does, in one value the mount and `drive status` can both read.
type FillPolicy struct {
	ReadAhead      string
	ChunkSizeLimit string
	MaxAge         string
	IdleCheck      time.Duration
}

// DefaultFillPolicy is the policy the mount carries.
func DefaultFillPolicy() FillPolicy {
	return FillPolicy{
		ReadAhead:      vfsReadAheadValue,
		ChunkSizeLimit: fillChunkSizeLimit,
		MaxAge:         fillMaxAge,
		IdleCheck:      fillIdleCheck,
	}
}

// ShouldFill reports whether the background fill runs right now.
func ShouldFill(offline bool, load1, load5 float64) bool {
	return offline || MachineIdle(load1, load5)
}

// MachineIdle is the load-average half of ShouldFill on its own.
func MachineIdle(load1, load5 float64) bool {
	return load1 < idleLoad && load5 < idleLoad
}

const idleLoad = 0.6

// FormatBytes renders a byte count the way `drive status` and the fill line read it, so a cache-size number in the CLI, in the fill report and in the docs are one format.
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
	// rclone's SizeSuffix: a bare number is bytes, a decimal is a multiple.
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
