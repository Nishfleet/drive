package main

import (
	"flag"
	"fmt"
	"os"
)

// usage is the command list from docs/build-spec.md. Step 2 of that spec ships
// mount, unmount and status; later steps add the rest.
const usage = `drive - a Finder drive for people and their agents

Usage:
  drive mount [flags]      write the rclone config and login item, start the mount
  drive unmount [flags]    stop the mount and the login item
  drive status [flags]     whether the drive is mounted, and where
  drive version            print the version

Mount flags:
  --endpoint    S3 endpoint URL (env DRIVE_S3_ENDPOINT)
  --bucket      storage bucket (env DRIVE_S3_BUCKET)
  --prefix      key prefix this device mounts (env DRIVE_S3_PREFIX)
  --region      S3 region name (env DRIVE_S3_REGION, default us-east-1)
  --access-key  access key id (env DRIVE_S3_ACCESS_KEY_ID)
  --secret-key  secret access key (env DRIVE_S3_SECRET_ACCESS_KEY)
  --home        home directory (default $HOME)
  --rclone      path to the rclone binary (env DRIVE_RCLONE, default rclone)
  --foreground  run rclone in this process instead of the login item
  --dry-run     print what would be written, write nothing
`

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "mount":
		err = runMount(os.Args[2:])
	case "unmount":
		err = runUnmount(os.Args[2:])
	case "status":
		err = runStatus(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "drive:", err)
		os.Exit(1)
	}
}

type commonFlags struct {
	home   string
	rclone string
}

func addCommonFlags(fs *flag.FlagSet) *commonFlags {
	c := &commonFlags{}
	fs.StringVar(&c.home, "home", os.Getenv("HOME"), "home directory")
	fs.StringVar(&c.rclone, "rclone", "", "path to the rclone binary (default rclone from PATH)")
	return c
}

func runMount(args []string) error {
	fs := flag.NewFlagSet("mount", flag.ContinueOnError)
	var endpoint, bucket, prefix, region, accessKey, secretKey string
	var foreground, dryRun bool
	fs.StringVar(&endpoint, "endpoint", "", "S3 endpoint URL")
	fs.StringVar(&bucket, "bucket", "", "storage bucket")
	fs.StringVar(&prefix, "prefix", "", "key prefix this device mounts")
	fs.StringVar(&region, "region", "", "S3 region name")
	fs.StringVar(&accessKey, "access-key", "", "access key id")
	fs.StringVar(&secretKey, "secret-key", "", "secret access key")
	fs.BoolVar(&foreground, "foreground", false, "run rclone in this process")
	fs.BoolVar(&dryRun, "dry-run", false, "print what would be written")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	c, err := LoadStorageConfig(endpoint, bucket, prefix, region, accessKey, secretKey)
	if err != nil {
		return err
	}
	rclone := common.rclone
	if rclone == "" {
		rclone = DefaultRcloneBin(common.home)
	}
	return Mount(CurrentGOOS(), common.home, rclone, c, foreground, dryRun)
}

func runUnmount(args []string) error {
	fs := flag.NewFlagSet("unmount", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	return Unmount(CurrentGOOS(), common.home)
}

func runStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	home := common.home
	mountDir := DefaultMountDir(home)
	on, err := Mounted(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	state := "not mounted"
	if on {
		state = "mounted"
	}
	fmt.Printf("drive: %s\n", state)
	fmt.Printf("mount dir: %s\n", mountDir)
	fmt.Printf("rclone config: %s\n", RcloneConfigPath(home))
	loginItem := LoginItemPath(CurrentGOOS(), home)
	exists := "absent"
	if _, err := os.Stat(loginItem); err == nil {
		exists = "present"
	}
	fmt.Printf("login item: %s (%s)\n", loginItem, exists)
	if files, err := os.ReadDir(mountDir); err == nil && len(files) > 0 {
		fmt.Printf("entries: %d\n", len(files))
	}
	return nil
}
