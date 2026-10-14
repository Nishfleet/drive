package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// MountPlan is everything needed to mount this device's drive with stock rclone.
type MountPlan struct {
	err         error
	GOOS        string
	Home        string
	DriveBin    string
	RcloneBin   string
	Subcommand  string
	Remote      string
	MountDir    string
	ConfigPath  string
	CacheDir    string
	CacheMax    string
	LogPath     string
	Bwlimit     string
	VFSArgs     []string
	Device      string
	RCAddr      string
	DownloadURL string
	RCUser      string
	RCPass      string
	SecretKey   string
	EnvPath     string
}

// VFSArgs are the stock rclone VFS flags this product mounts with.
func VFSArgs(cacheMax string) []string {
	return []string{
		"--vfs-cache-mode", vfsCacheModeValue,
		"--vfs-write-back", vfsWriteBackValue,
		"--vfs-cache-max-size", cacheMax,
		"--vfs-cache-min-free-space", vfsCacheMinFreeSpaceValue,
		// rclone re-lists when the directory cache is older than this and returns the error on failure, with no stale-on-error (https://github.com/rclone/rclone/issues/1963).
		"--dir-cache-time", vfsDirCacheTimeValue,
		"--vfs-read-chunk-size", tunedVFSValue("VFS_READ_CHUNK_SIZE", vfsReadChunkSizeValue),
		"--vfs-read-chunk-streams", tunedVFSValue("VFS_READ_CHUNK_STREAMS", vfsReadChunkStreamsValue),
		"--buffer-size", tunedVFSValue("BUFFER_SIZE", vfsChunkStreamSize),
		"--transfers", tunedVFSValue("TRANSFERS", vfsTransfersValue),
		"--vfs-read-ahead", tunedVFSValue("VFS_READ_AHEAD", vfsReadAheadValue),
		"--vfs-read-chunk-size-limit", vfsChunkSizeLimit(),
		"--vfs-cache-max-age", vfsMaxAge(),
	}
}

func tunedVFSValue(envSuffix, shipped string) string {
	if v, ok := os.LookupEnv("DRIVE_BENCH_" + envSuffix); ok {
		if strings.TrimSpace(v) == "" {
			return shipped
		}
		return v
	}
	return shipped
}

// RemoteFor joins the bucket and optional key prefix into an rclone remote path.
func RemoteFor(c StorageConfig) string {
	prefix := strings.Trim(c.Prefix, "/")
	if prefix == "" {
		return RcloneRemoteName + ":" + c.Bucket
	}
	return RcloneRemoteName + ":" + c.Bucket + "/" + prefix
}

// BuildMountPlan resolves the mount command for goos.
func BuildMountPlan(goos, home, rcloneBin string, c StorageConfig) MountPlan {
	cacheMax, err := ResolveCacheMax(home)
	if err != nil {
		return MountPlan{CacheMax: vfsCacheMaxValue, err: err}
	}
	sub := "mount"
	if goos == "darwin" {
		sub = "nfsmount"
	}
	return MountPlan{
		GOOS:        goos,
		Home:        home,
		RcloneBin:   rcloneBin,
		Subcommand:  sub,
		Remote:      RemoteFor(c),
		MountDir:    mountDirFor(goos, home),
		ConfigPath:  RcloneConfigPath(home),
		CacheDir:    DefaultCacheDir(home),
		CacheMax:    cacheMax,
		LogPath:     filepath.Join(DefaultConfigDir(home), "mount.log"),
		VFSArgs:     VFSArgs(cacheMax),
		Device:      DeviceName(),
		RCAddr:      RCAddr(),
		DownloadURL: c.DownloadURL,
		Bwlimit:     PausedRate(home),
	}
}

func prepareMountAuth(home string, p *MountPlan, c StorageConfig) error {
	auth, err := ReadRCAuth(home)
	if err != nil {
		auth = RCAuth{}
	}
	if auth.User == "" || auth.Pass == "" {
		user, pass, err := generateRCAuth()
		if err != nil {
			return err
		}
		auth.User, auth.Pass = user, pass
	}
	if auth.Addr == "" {
		addr, err := pickRCAddr()
		if err != nil {
			return err
		}
		auth.Addr = addr
	}
	p.RCUser = auth.User
	p.RCPass = auth.Pass
	p.RCAddr = auth.Addr
	p.SecretKey = c.SecretKey
	return WriteRcloneEnv(home, c, auth.User, auth.Pass, auth.Addr)
}

func generateRCAuth() (user, pass string, err error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", "", fmt.Errorf("generate rclone rc password: %w", err)
	}
	return hex.EncodeToString(buf[:16]), hex.EncodeToString(buf[16:]), nil
}

func rcloneProcessEnv(p MountPlan) []string {
	env := os.Environ()
	if p.RCUser != "" {
		env = overrideEnv(env, rcloneRCUserEnv, p.RCUser)
		env = overrideEnv(env, rcloneRCPassEnv, p.RCPass)
	}
	if p.SecretKey != "" {
		env = overrideEnv(env, rcloneSecretEnv, p.SecretKey)
	}
	if p.DownloadURL != "" {
		env = overrideEnv(env, rcloneDownloadURLEnv, p.DownloadURL)
	}
	return env
}

func overrideEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, prefix) {
			out = append(out, e)
		}
	}
	return append(out, prefix+value)
}

func rcloneEnvRedacted(p MountPlan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s=<redacted>\n", rcloneRCUserEnv)
	fmt.Fprintf(&b, "%s=<redacted>\n", rcloneRCPassEnv)
	fmt.Fprintf(&b, "%s=<redacted>\n", rcloneSecretEnv)
	return b.String()
}

func rcClientForMount(p MountPlan) *rcClient {
	c := newRCClient(p.RcloneBin, p.RCAddr, p.Remote)
	c.SetAuth(p.RCUser, p.RCPass)
	return c
}

const deviceEnvName = "DRIVE_DEVICE"

// DeviceName is the name this device carries in a conflict copy's filename (issue #30).
func DeviceName() string {
	if set := strings.TrimSpace(os.Getenv(deviceEnvName)); set != "" {
		if name := SanitizeDevice(set); name != "" {
			return name
		}
	}
	return DefaultDeviceName()
}

// RCAddr is the loopback address a command that has not yet prepared a mount would bind.
func RCAddr() string {
	if set := strings.TrimSpace(os.Getenv(rcAddrEnvName)); set != "" {
		if IsLoopbackAddr(set) {
			return set
		}
		return loopbackRCAddr
	}
	return loopbackRCAddr
}

func pickRCAddr() (string, error) {
	if set := strings.TrimSpace(os.Getenv(rcAddrEnvName)); set != "" && IsLoopbackAddr(set) {
		return set, nil
	}
	return listenLoopbackRCAddr()
}

func listenLoopbackRCAddr() (string, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("bind a free loopback port for rclone rc: %w", err)
	}
	addr := l.Addr().String()
	if err := l.Close(); err != nil {
		return "", fmt.Errorf("release the rc probe port: %w", err)
	}
	if !IsLoopbackAddr(addr) {
		return "", fmt.Errorf("probe port %s is not loopback", addr)
	}
	return addr, nil
}

// IsLoopbackAddr reports whether addr is a loopback host:port.
func IsLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	switch strings.ToLower(host) {
	case "localhost", "localhost.":
		return true
	}
	return false
}

func mountDirFor(goos, home string) string {
	if goos == "windows" {
		return windowsDefaultLetter
	}
	return DefaultMountDir(home)
}

// Args is the full rclone argument vector, in the order the docs show.
func (p MountPlan) Args() []string {
	return p.args(true)
}

func (p MountPlan) loginItemArgs() []string {
	return p.args(false)
}

func (p MountPlan) productArgs() []string {
	args := []string{"mount", "--foreground", "--home", p.Home}
	if p.RcloneBin != "" {
		args = append(args, "--rclone", p.RcloneBin)
	}
	if p.Device != "" {
		args = append(args, "--device", p.Device)
	}
	if p.RCAddr != "" {
		args = append(args, "--rc-addr", p.RCAddr)
	}
	if p.GOOS == "windows" && p.MountDir != "" {
		args = append(args, "--drive-letter", p.MountDir)
	}
	return args
}

func (p MountPlan) productArgv() []string {
	if p.isAgent() {
		return append([]string{p.RcloneBin}, p.loginItemArgs()...)
	}
	return append([]string{p.DriveBin}, p.productArgs()...)
}

func (p MountPlan) isAgent() bool {
	return p.EnvPath != ""
}

var lookupDriveBin = os.Executable

func attachDriveBin(p *MountPlan) error {
	if p.DriveBin != "" {
		return nil
	}
	exe, err := lookupDriveBin()
	if err != nil {
		return fmt.Errorf("resolve drive binary: %w", err)
	}
	p.DriveBin = exe
	return nil
}

func (p MountPlan) args(includeRCAuth bool) []string {
	args := []string{
		p.Subcommand,
		p.Remote,
		p.MountDir,
		"--config", p.ConfigPath,
	}
	args = append(args, p.VFSArgs...)
	args = append(args,
		"--cache-dir", p.CacheDir,
		"--log-file", p.LogPath,
		"--log-level", "INFO",
	)
	if p.RCAddr != "" {
		args = append(args, "--rc", "--rc-addr", p.RCAddr)
	}
	if includeRCAuth && p.RCUser != "" {
		args = append(args, "--rc-user", p.RCUser, "--rc-pass", p.RCPass)
	}
	if p.Bwlimit != "" {
		args = append(args, "--bwlimit", p.Bwlimit)
	}
	return args
}

// CommandLine is the shell-safe rendering of Args, used in messages.
func (p MountPlan) CommandLine() string {
	parts := append([]string{p.RcloneBin}, p.Args()...)
	for i, a := range parts {
		if strings.ContainsAny(a, " \t\"'") {
			parts[i] = "'" + strings.ReplaceAll(a, "'", "'\\''") + "'"
		}
	}
	return strings.Join(parts, " ")
}

// LaunchdPlist renders the macOS login item that keeps the mount running.
func LaunchdPlist(p MountPlan) string {
	return LaunchdPlistFor(p, LaunchdLabel)
}

// LaunchdPlistFor is LaunchdPlist for a login item whose label is not the device mount's own: one label per agent path, because launchd runs one ProcessArguments list per label and a tool's rclone must be its own (drive#514).
func LaunchdPlistFor(p MountPlan, label string) string {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	b.WriteString("<plist version=\"1.0\">\n<dict>\n")
	fmt.Fprintf(&b, "\t<key>Label</key>\n\t<string>%s</string>\n", html.EscapeString(label))
	b.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString("/bin/sh"))
	fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString("-c"))
	fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString(`/sbin/mount -t nfs | grep -F " on $1 (" >/dev/null 2>&1 && /sbin/umount -f "$1"; shift; exec "$@"`))
	fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString("drive-mount"))
	fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString(p.MountDir))
	for _, a := range p.productArgv() {
		fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString(a))
	}
	b.WriteString("\t</array>\n")
	b.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	b.WriteString("\t<key>KeepAlive</key>\n\t<true/>\n")
	fmt.Fprintf(&b, "\t<key>StandardOutPath</key>\n\t<string>%s</string>\n", html.EscapeString(p.LogPath))
	fmt.Fprintf(&b, "\t<key>StandardErrorPath</key>\n\t<string>%s</string>\n", html.EscapeString(p.LogPath))
	if p.isAgent() && (p.SecretKey != "" || p.DownloadURL != "") {
		b.WriteString("\t<key>EnvironmentVariables</key>\n\t<dict>\n")
		if p.SecretKey != "" {
			fmt.Fprintf(&b, "\t\t<key>%s</key>\n\t\t<string>%s</string>\n", rcloneSecretEnv, html.EscapeString(p.SecretKey))
		}
		if p.DownloadURL != "" {
			fmt.Fprintf(&b, "\t\t<key>%s</key>\n\t\t<string>%s</string>\n", rcloneDownloadURLEnv, html.EscapeString(p.DownloadURL))
		}
		b.WriteString("\t</dict>\n")
	}
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

// SystemdUnit renders the Linux login item (step 3).
func SystemdUnit(p MountPlan) string {
	if p.isAgent() {
		return agentSystemdUnit(p)
	}
	return fmt.Sprintf(`[Unit]
Description=drive: mount the drive and run the product loops
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=%s
ExecStart=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, systemdClearStalePre(p.MountDir), systemdCommandLine(p))
}

func agentSystemdUnit(p MountPlan) string {
	return fmt.Sprintf(`[Unit]
Description=drive: %s mounted with stock rclone
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%s
ExecStartPre=%s
ExecStart=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, p.Remote, systemdEscapeArg(p.envFile()), systemdClearStalePre(p.MountDir), systemdCommandLine(p))
}

func systemdClearStalePre(mountDir string) string {
	script := `$2 -n -M "$1" -t fuse.rclone,fuse >/dev/null 2>&1 && { $3 -uz "$1" || $4 -uz "$1"; }`
	return "-/bin/sh -c " + strings.Join([]string{
		systemdEscapeArg(script),
		systemdEscapeArg("drive-pre"),
		systemdEscapeArg(mountDir),
		systemdEscapeArg(lookBin("findmnt", "/usr/bin/findmnt")),
		systemdEscapeArg(lookBin("fusermount3", "/usr/bin/fusermount3")),
		systemdEscapeArg(lookBin("fusermount", "/usr/bin/fusermount")),
	}, " ")
}

func lookBin(name, fallback string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return fallback
}

func (p MountPlan) envFile() string {
	if p.EnvPath != "" {
		return p.EnvPath
	}
	return filepath.Join(filepath.Dir(p.ConfigPath), "rclone.env")
}

func systemdCommandLine(p MountPlan) string {
	parts := p.productArgv()
	for i, a := range parts {
		parts[i] = systemdEscapeArg(a)
	}
	return strings.Join(parts, " ")
}

func systemdEscapeArg(arg string) string {
	arg = strings.ReplaceAll(arg, "%", "%%")
	if !strings.ContainsAny(arg, " \t\"'\\") {
		return arg
	}
	arg = strings.ReplaceAll(arg, `\`, `\\`)
	arg = strings.ReplaceAll(arg, `"`, `\"`)
	return `"` + arg + `"`
}

// LoginItemPath is where the login item for goos is written.
func LoginItemPath(goos, home string) string {
	switch goos {
	case "darwin":
		return LaunchdPlistPath(home)
	case "windows":
		return ""
	default:
		return SystemdUnitPath(home)
	}
}

// LoginItem renders the login item for goos.
func LoginItem(goos string, p MountPlan) string {
	switch goos {
	case "darwin":
		return LaunchdPlist(p)
	case "windows":
		return WindowsTaskCommandLine(p)
	default:
		return SystemdUnit(p)
	}
}

// LoginItemPresent answers whether the login item for goos is registered.
func LoginItemPresent(goos, home string) (bool, error) {
	if goos == "windows" {
		return windowsTaskPresent(WindowsTaskName)
	}
	path := LoginItemPath(goos, home)
	if _, err := os.Stat(path); err == nil {
		return true, nil
	} else if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	} else {
		return false, fmt.Errorf("stat %s: %w", path, err)
	}
}

// LoginItemFiles are the on-disk login-item files for goos.
func LoginItemFiles(goos, home string) []string {
	if goos == "windows" {
		return nil
	}
	return []string{LoginItemPath(goos, home), PrefetchLoginItemPath(goos, home), DeviceRenewLoginItemPath(goos, home)}
}

// Mount writes the rclone config and the login item, then starts the mount.
func Mount(goos, home, rcloneBin string, c StorageConfig, foreground, dryRun bool, driveLetter string) error {
	p := BuildMountPlan(goos, home, rcloneBin, c)
	if p.err != nil {
		return p.err
	}
	if err := attachDriveBin(&p); err != nil {
		return err
	}
	if goos == "windows" {
		letter, err := WindowsDriveLetter(driveLetter, driveLetterFree)
		if err != nil {
			return err
		}
		p.MountDir = letter
		return mountWindows(p, home, c, foreground, dryRun)
	}
	itemPath := LoginItemPath(goos, home)
	itemMode := os.FileMode(0o644)
	if goos == "darwin" {
		itemMode = 0o600
	}
	prefetchItem := []byte(PrefetchLoginItem(goos, p.DriveBin, home))
	prefetchPath := PrefetchLoginItemPath(goos, home)
	renewItem := []byte(DeviceRenewLoginItem(goos, p.DriveBin, home))
	renewPath := DeviceRenewLoginItemPath(goos, home)
	if dryRun {
		p.RCUser, p.RCPass = "<redacted>", "<redacted>"
		item := []byte(LoginItem(goos, p))
		fmt.Printf("--- %s ---\n%s", p.ConfigPath, RcloneConfigRedacted(c))
		fmt.Printf("--- %s ---\n%s", RcloneEnvPath(home), rcloneEnvRedacted(p))
		fmt.Printf("--- %s ---\n%s", itemPath, item)
		fmt.Printf("--- %s ---\n%s", prefetchPath, prefetchItem)
		if renewPath != "" {
			fmt.Printf("--- %s ---\n%s", renewPath, renewItem)
		}
		fmt.Printf("--- would run ---\n%s\n", p.CommandLine())
		return nil
	}
	if p.Device == "" {
		return fmt.Errorf("device name is empty: set --device or DRIVE_DEVICE to a name " +
			"this mount can carry in a conflict filename")
	}
	envBefore, envBeforeErr := os.ReadFile(RcloneEnvPath(home))
	if err := prepareMountAuth(home, &p, c); err != nil {
		return err
	}
	envAfter, envAfterErr := os.ReadFile(RcloneEnvPath(home))
	envChanged := envBeforeErr != nil || envAfterErr != nil || !bytes.Equal(envBefore, envAfter)
	item := []byte(LoginItem(goos, p))
	writes := []mountWrite{
		{p.ConfigPath, []byte(RcloneConfig(c)), 0o600},
		{itemPath, item, itemMode},
		{prefetchPath, prefetchItem, 0o644},
	}
	if renewPath != "" && len(renewItem) > 0 {
		writes = append(writes, mountWrite{renewPath, renewItem, 0o644})
	}
	if err := clearStaleMountDir(goos, p.MountDir); err != nil {
		return err
	}
	if err := os.MkdirAll(p.MountDir, 0o755); err != nil {
		return driveFolderCreateError(err, p.MountDir)
	}
	var holding string
	var strays []string
	if on, _ := MountedDir(goos, p.MountDir); !on {
		var err error
		holding, strays, err = parkStrayMountFiles(p.MountDir)
		if err != nil {
			return err
		}
	} else if err := reclaimStrayHoldings(p.MountDir); err != nil {
		fmt.Fprintf(os.Stderr, "note: local files beside %s could not be copied into the drive (%v); copy them by hand\n", p.MountDir, err)
	}
	if len(strays) > 0 {
		fmt.Fprintf(os.Stderr, "note: %s already had local files; they were moved to %s so the drive can mount, and they will be copied into the drive once it is up\n", p.MountDir, holding)
	}
	placed := false
	defer func() {
		if !placed && holding != "" {
			_ = restoreStrayMountFiles(holding, p.MountDir)
		}
	}()
	if err := writeCacheTag(p.CacheDir); err != nil {
		return err
	}
	if !envChanged && mountWritesUnchanged(goos, writes) {
		up, probeErr := mountState(goos, home)
		if probeErr != nil {
			return failDetail("mount-probe", probeErr, p.MountDir, probeErr.Error())
		}
		skipRestart := false
		if up {
			fmt.Printf("Mount already running at %s\n", p.MountDir)
			skipRestart = true
		}
		if skipRestart {
			if err := startPrefetchLoginItem(goos, home, prefetchPath); err != nil {
				fmt.Fprintf(os.Stderr, "note: prefetch login item not started (%v); it is written at %s\n", err, prefetchPath)
			}
			if err := startDeviceRenewSidecar(goos, home, renewPath, foreground); err != nil {
				fmt.Fprintf(os.Stderr, "note: device-key renew login item not started (%v); it is written at %s\n", err, renewPath)
			}
			excludeTransientFromBackup(goos, p)
			return nil
		}
	}
	for _, w := range writes {
		if err := WriteFileAtomic(w.path, w.data, w.mode); err != nil {
			return err
		}
	}
	if foreground {
		if err := stopDeviceRenewLoginItem(goos, home); err != nil {
			fmt.Fprintf(os.Stderr, "note: device-key renew login item not stopped (%v)\n", err)
		}
		placed = true
		var once sync.Once
		restore := func() {
			once.Do(func() {
				if err := restoreStrayMountFiles(holding, p.MountDir); err != nil {
					fmt.Fprintf(os.Stderr, "note: local files at %s could not be copied into the drive (%v); copy them by hand from that folder\n", holding, err)
				}
			})
		}
		if holding != "" {
			go func() {
				if waitMounted(goos, home) == nil {
					restore()
				}
			}()
		}
		err := mountForeground(p, home)
		restore()
		return err
	}
	if err := startLoginItem(goos, p, itemPath); err != nil {
		return err
	}
	if err := waitMounted(goos, home); err != nil {
		return err
	}
	if err := restoreStrayMountFiles(holding, p.MountDir); err != nil {
		fmt.Fprintf(os.Stderr, "note: local files at %s could not be copied into the drive (%v); copy them by hand from that folder\n", holding, err)
	}
	placed = true
	if err := startPrefetchLoginItem(goos, home, prefetchPath); err != nil {
		fmt.Fprintf(os.Stderr, "note: prefetch login item not started (%v); it is written at %s\n", err, prefetchPath)
	}
	if err := startDeviceRenewSidecar(goos, home, renewPath, foreground); err != nil {
		fmt.Fprintf(os.Stderr, "note: device-key renew login item not started (%v); it is written at %s\n", err, renewPath)
	}
	excludeTransientFromBackup(goos, p)
	printMountedLine(p.MountDir)
	return nil
}

type mountWrite struct {
	path string
	data []byte
	mode os.FileMode
}

func mountWritesUnchanged(goos string, writes []mountWrite) bool {
	for _, w := range writes {
		info, err := os.Stat(w.path)
		if err != nil {
			return false
		}
		if goos != "windows" && info.Mode().Perm() != w.mode.Perm() {
			return false
		}
		onDisk, err := os.ReadFile(w.path)
		if err != nil || !bytes.Equal(onDisk, w.data) {
			return false
		}
	}
	return true
}

var mountState = Mounted

var waitProbe = Mounted

var startLoginItem = startPlatformLoginItem

func startPlatformLoginItem(goos string, p MountPlan, itemPath string) error {
	if goos == "darwin" {
		if err := bootstrapLaunchd(itemPath); err != nil {
			return failDetail("login-item", err)
		}
		return nil
	}
	if err := startLinuxLoginItem(); err != nil {
		if !systemdUserSessionAbsent(err) {
			return failDetail("login-item", err)
		}
		fmt.Fprintf(os.Stderr, "note: systemd user session is not available (%v); starting the mount in the background. The login item is at %s\n", err, itemPath)
		if err := startLinuxMountDetached(p); err != nil {
			return failDetail("mount-failed", err)
		}
	}
	return nil
}

const cacheDirTag = "Signature: 8a477f597d28d172769f0698c07c4e93\n" +
	"* This file is a cache directory tag. See https://bford.info/cachedir/ for information about cache directory systems that use it.\n"

func writeCacheTag(cacheDir string) error {
	if cacheDir == "" {
		return nil
	}
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return failDetail("cache-tag", err, cacheDir)
	}
	if err := WriteFileAtomic(filepath.Join(cacheDir, "CACHEDIR.TAG"), []byte(cacheDirTag), 0o644); err != nil {
		return failDetail("cache-tag", err, cacheDir)
	}
	return nil
}

func excludeTransientFromBackup(goos string, p MountPlan) {
	if goos != "darwin" {
		return
	}
	if p.CacheDir == "" {
		return
	}
	if out, err := exec.Command("tmutil", "addexclusion", p.CacheDir).CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "note: could not exclude %s from Time Machine backups (%v): %s\n", p.CacheDir, err, out)
	}
}

func startLinuxLoginItem() error {
	for _, action := range mountSystemctlActions() {
		args := []string{"--user", action}
		if action != "daemon-reload" {
			args = append(args, SystemdUnitName)
		}
		if err := exec.Command("systemctl", args...).Run(); err != nil {
			return fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
		}
	}
	return nil
}

func systemdUserSessionAbsent(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	for _, absent := range []string{
		"executable file not found",
		"Failed to connect to bus",
		"not been booted with systemd",
		"XDG_RUNTIME_DIR not set",
	} {
		if strings.Contains(msg, absent) {
			return true
		}
	}
	return false
}

func startLinuxMountDetached(p MountPlan) error {
	if p.DriveBin == "" {
		return fmt.Errorf("drive binary is empty")
	}
	if err := os.MkdirAll(filepath.Dir(p.LogPath), 0o755); err != nil {
		return fmt.Errorf("create log dir: %w", err)
	}
	log, err := os.OpenFile(p.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open mount log %s: %w", p.LogPath, err)
	}
	defer log.Close()
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(p.DriveBin, p.productArgs()...)
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.Env = envWithoutDriveS3(os.Environ())
	cmd.SysProcAttr = detachedProcAttr()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("drive mount: %w", err)
	}
	return nil
}

func envWithoutDriveS3(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		if strings.HasPrefix(e, "DRIVE_S3_") {
			continue
		}
		out = append(out, e)
	}
	return out
}

func mountForeground(p MountPlan, home string) error {
	rclonePath, err := exec.LookPath(p.RcloneBin)
	if err != nil {
		return failDetail("no-rclone", err)
	}
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	cmd := exec.Command(rclonePath, p.Args()...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = rcloneProcessEnv(p)
	if err := cmd.Start(); err != nil {
		return failDetail("mount-failed", fmt.Errorf("rclone mount: %w", err), p.LogPath)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if prefetchEnabled() {
		go runPrefetchLoop(ctx, p.MountDir)
	}
	fillCtx, cancelFill := context.WithCancel(context.Background())
	go func() {
		// rclone's remote control is not listening for the first moments of the mount.
		_, _ = MountedDir(p.GOOS, p.MountDir)
		c := rcClientForMount(p)
		for err := range RunFillLoop(fillCtx, c, home, p.MountDir) {
			fmt.Fprintf(os.Stderr, "drive: background fill: %v\n", err)
		}
	}()
	conflictCtx, cancelConflict := context.WithCancel(context.Background())
	go func() {
		_, _ = MountedDir(p.GOOS, p.MountDir)
		c := rcClientForMount(p)
		for err := range RunConflictLoop(conflictCtx, p.Device, p.MountDir, p.CacheDir, p.Remote, ConflictGuardStatePath(home), c) {
			fmt.Fprintf(os.Stderr, "drive: conflict guard: %v\n", err)
		}
	}()
	queueCtx, cancelQueue := context.WithCancel(context.Background())
	go func() {
		_, _ = MountedDir(p.GOOS, p.MountDir)
		c := rcClientForMount(p)
		for err := range RunQueueReportLoop(queueCtx, c, home) {
			fmt.Fprintf(os.Stderr, "drive: queue report: %v\n", err)
		}
	}()
	renewCtx, cancelRenew := context.WithCancel(context.Background())
	if deviceRenewEnabled() {
		go func() {
			_, _ = MountedDir(p.GOOS, p.MountDir)
			if err := runDeviceRenewLoop(renewCtx, home, os.Getenv("DRIVE_API_URL")); err != nil && !errors.Is(err, context.Canceled) {
				fmt.Fprintf(os.Stderr, "drive: device key renew: %v\n", err)
			}
		}()
	}
	stop := make(chan os.Signal, 2)
	quit := make(chan struct{})
	joined := make(chan struct{})
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		defer close(joined)
		for {
			select {
			case sig := <-stop:
				_ = cmd.Process.Signal(sig)
			case <-quit:
				return
			}
		}
	}()
	runErr := cmd.Wait()
	cancel()
	signal.Stop(stop)
	close(quit)
	<-joined
	cancelFill()
	cancelConflict()
	cancelQueue()
	cancelRenew()
	if runErr != nil {
		return failDetail("mount-failed", fmt.Errorf("rclone mount: %w", runErr), p.LogPath)
	}
	return nil
}

func printMountedLine(mountDir string) {
	fmt.Printf("Mounted at %s. Try: echo hello > %q\n", mountDir, filepath.Join(mountDir, "hello.txt"))
}

func waitMounted(goos, home string) error {
	return waitMountedFor(goos, home, mountWait, 200*time.Millisecond, os.Stdout)
}

func waitMountedFor(goos, home string, wait, tick time.Duration, out io.Writer) error {
	fmt.Fprint(out, "Starting the mount ")
	defer fmt.Fprintln(out)
	deadline := time.Now().Add(wait)
	shown := 0
	for time.Now().Before(deadline) {
		on, err := waitProbe(goos, home)
		if err != nil {
			return err
		}
		if on {
			return nil
		}
		time.Sleep(tick)
		shown++
		if shown%3 == 0 {
			fmt.Fprint(out, ".")
		}
	}
	return failDetail("mount-hung", nil, wait.String(), mountLogHint(goos, home))
}

const mountWait = 30 * time.Second

func mountLogHint(goos, home string) string {
	if goos == "darwin" || goos == "windows" {
		return filepath.Join(DefaultConfigDir(home), "mount.log")
	}
	return "journalctl --user -u " + SystemdUnitName
}

func mountSystemctlActions() []string {
	return []string{"daemon-reload", "enable", "restart"}
}

// launchctl `load` and `unload -w` are deprecated and not idempotent.
func bootstrapLaunchd(itemPath string) error {
	return bootstrapLaunchdLabel(LaunchdLabel, itemPath)
}

func bootstrapLaunchdLabel(label, itemPath string) error {
	target := launchctlTarget()
	if launchctlLoadedLabel(target, label) {
		if out, err := exec.Command("launchctl", launchctlArgvLabel(label, "bootout", target, itemPath)...).CombinedOutput(); err != nil {
			return fmt.Errorf("launchctl bootout %s: %w: %s", target, err, strings.TrimSpace(string(out)))
		}
	}
	if out, err := exec.Command("launchctl", launchctlArgvLabel(label, "bootstrap", target, itemPath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootstrap %s %s: %w: %s", target, itemPath, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func bootoutLaunchd(itemPath string) error {
	return bootoutLaunchdLabel(LaunchdLabel, itemPath)
}

func bootoutLaunchdLabel(label, itemPath string) error {
	target := launchctlTarget()
	if !launchctlLoadedLabel(target, label) {
		return nil
	}
	if out, err := exec.Command("launchctl", launchctlArgvLabel(label, "bootout", target, itemPath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("launchctl bootout %s: %w: %s", target, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func launchctlTarget() string { return fmt.Sprintf("gui/%d", os.Getuid()) }

func launchctlLoadedLabel(target, label string) bool {
	return exec.Command("launchctl", launchctlArgvLabel(label, "print", target, "")...).Run() == nil
}

func launchctlArgv(action, target, itemPath string) []string {
	return launchctlArgvLabel(LaunchdLabel, action, target, itemPath)
}

func launchctlArgvLabel(label, action, target, itemPath string) []string {
	switch action {
	case "print":
		return []string{"print", target + "/" + label}
	case "bootout":
		return []string{"bootout", target + "/" + label}
	case "bootstrap":
		return []string{"bootstrap", target, itemPath}
	}
	return nil
}

// RestartMount stops the mount and starts it again so rclone picks up a swapped storage key (core/cap.js `mount.restart`).
func RestartMount(goos, home, rcloneBin string, c StorageConfig) error {
	driveLetter := ""
	if goos == "windows" {
		if letter, err := windowsMountLetter(); err == nil {
			driveLetter = letter
		}
	}
	if err := Unmount(goos, home); err != nil {
		return err
	}
	return Mount(goos, home, rcloneBin, c, false, false, driveLetter)
}
func Unmount(goos, home string) error {
	if goos == "windows" {
		return unmountWindows(home)
	}
	if err := stopPrefetchLoginItem(goos, home); err != nil {
		fmt.Fprintf(os.Stderr, "note: could not disable the prefetch login item (%v)\n", err)
	}
	if err := stopDeviceRenewLoginItem(goos, home); err != nil {
		fmt.Fprintf(os.Stderr, "note: could not disable the device-key renew login item (%v)\n", err)
	}
	itemPath := LoginItemPath(goos, home)
	var disableErr error
	if _, err := os.Stat(itemPath); err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return failDetail("unexpected", fmt.Errorf("stat %s: %w", itemPath, err))
		}
	} else if goos == "darwin" {
		disableErr = bootoutLaunchd(itemPath)
	} else if err := exec.Command("systemctl", "--user", "disable", "--now", SystemdUnitName).Run(); err != nil {
		disableErr = fmt.Errorf("systemctl --user disable --now %s: %w", SystemdUnitName, err)
	}
	if stopErr := stopMount(goos, home); stopErr != nil {
		if disableErr != nil {
			return failDetail("unexpected", fmt.Errorf("%v; unmount: %w", disableErr, stopErr))
		}
		return failDetail("unmount-failed", stopErr, DefaultMountDir(home))
	}
	if disableErr != nil {
		return failDetail("unexpected", disableErr)
	}
	return nil
}

func clearStaleMountDir(goos, mountDir string) error {
	if !mountDirNotConnected(goos, mountDir) {
		return nil
	}
	if uerr := lazyUnmount(goos, mountDir); uerr != nil {
		return failDetail("stale-mount", uerr, mountDir)
	}
	return nil
}

func lazyUnmount(goos, mountDir string) error {
	var err error
	if goos == "darwin" {
		err = runUmountFlag(mountDir, "-f")
	} else {
		err = runFusermountFlag(mountDir, "-uz")
	}
	if err == nil {
		return nil
	}
	on, merr := MountedDir(goos, mountDir)
	if merr == nil && !on {
		return nil
	}
	return err
}

func mountDirNotConnected(goos, dir string) bool {
	on, err := MountedDir(goos, dir)
	if err != nil {
		return true
	}
	if !on {
		return false
	}
	return !mountDirAnswers(dir)
}

func mountDirAnswers(dir string) bool {
	type result struct{ err error }
	done := make(chan result, 1)
	go func() {
		_, err := os.Lstat(dir)
		done <- result{err}
	}()
	select {
	case r := <-done:
		return !isNotConnected(r.err)
	case <-time.After(2 * time.Second):
		return false
	}
}

func isNotConnected(err error) bool {
	return err != nil && (errors.Is(err, syscall.ENOTCONN) || errors.Is(err, syscall.ENXIO))
}

func driveFolderCreateError(err error, mountDir string) error {
	if isNotConnected(err) {
		return failDetail("stale-mount", err, mountDir)
	}
	return failDetail("drive-folder", err, mountDir)
}

// Mounted reports whether MountDir has a live mount.
func Mounted(goos, home string) (bool, error) {
	if goos == "windows" {
		letter, err := windowsMountLetter()
		if err != nil {
			return false, err
		}
		return windowsVolumeMounted(letter), nil
	}
	return MountedDir(goos, DefaultMountDir(home))
}

// MountedDir is Mounted for a mount point that is not <home>/Drive, so a caller holding the mount point itself (the proofs, whose dir may be a second mount on the same host) asks the same platform question.
func MountedDir(goos, mountDir string) (bool, error) {
	// A FUSE mount whose backing store has gone away can block findmnt the same way it blocks ReadDir.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	switch goos {
	case "darwin":
		out, err := exec.CommandContext(ctx, "mount").Output()
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return false, fmt.Errorf("mount: timed out")
			}
			return false, fmt.Errorf("mount: %w", err)
		}
		return bsdMountHasMountPoint(string(out), mountDir), nil
	case "windows":
		return windowsVolumeMounted(mountDir), nil
	default:
		out, err := exec.CommandContext(ctx, "findmnt", "-n", "-M", mountDir).Output()
		if err != nil {
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return false, fmt.Errorf("findmnt %s: timed out", mountDir)
			}
			if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
				return false, nil
			}
			return false, fmt.Errorf("findmnt %s: %w", mountDir, err)
		}
		return strings.TrimSpace(string(out)) != "", nil
	}
}

func bsdMountHasMountPoint(listing, dir string) bool {
	for _, line := range strings.Split(listing, "\n") {
		i := strings.Index(line, " on ")
		if i < 0 {
			continue
		}
		point := line[i+len(" on "):]
		if j := strings.LastIndex(point, " ("); j > 0 {
			point = point[:j]
		}
		if unescapeMountField(point) == dir {
			return true
		}
	}
	return false
}

func unescapeMountField(s string) string {
	return strings.NewReplacer(`\040`, " ", `\011`, "\t", `\134`, `\`).Replace(s)
}

// ResolveRclone turns the operator's rclone setting into an absolute binary path.
func ResolveRclone(rclone string) (string, error) {
	if rclone == "" {
		rclone = os.Getenv("DRIVE_RCLONE")
	}
	if rclone == "" {
		path, err := exec.LookPath("rclone")
		if err != nil {
			return "", failDetail("no-rclone", err)
		}
		return absPath(path)
	}
	parent, err := exec.LookPath(rclone)
	if err != nil {
		return "", failDetail("no-rclone", fmt.Errorf("rclone binary %q not found", rclone))
	}
	return absPath(parent)
}

func absPath(p string) (string, error) {
	if filepath.IsAbs(p) {
		return p, nil
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", p, err)
	}
	return abs, nil
}

// CurrentGOOS is split out so tests can inject a platform.
func CurrentGOOS() string { return runtime.GOOS }
