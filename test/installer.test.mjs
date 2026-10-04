// The Windows installer (drive issue #154), checked here rather than trusted.
//
// The MSI is built on windows-latest by installer/windows-msi.yml, so nothing
// in this file proves the MSI runs: it proves the sources still say what the
// issue asks for. Each line below is one of the issue's promises, and each is
// matched against the file that carries it, so a later edit that drops the
// PATH entry or the WinFsp chain fails the suite instead of shipping an
// installer that quietly stops doing one of them.
//
// What this file cannot check, and says so in the PR: that the MSI builds, that
// msiexec /qn installs it silently, and that the drive letter round-trips a
// write. Those are the windows-latest job's own output.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const MSI = read("installer/drive.wxs");
const BUNDLE = read("installer/bundle.wxs");
const WORKFLOW = read("installer/windows-msi.yml");

/** @param {string} path @param {RegExp} what @param {string} why */
const asserts = (path, what, why) => {
  assert.match(read(path), what, `${path} ${why}`);
};

test("the MSI installs drive.exe and rclone.exe side by side", () => {
  for (const [name, component] of [
    ["drive.exe", "DriveExe"],
    ["rclone.exe", "RcloneExe"],
  ]) {
    const line = MSI.split("\n").find((l) => l.includes(`Id="${name}"`));
    assert.ok(line, `drive.wxs must install ${name}`);
    assert.match(line, /KeyPath="yes"/, `${name} is the component's key path`);
    assert.match(
      MSI.split("\n").find((l) => l.includes(`Id="${component}"`)) ?? "",
      /Guid="[0-9A-F-]{36}"/,
      `${component} needs a fixed GUID, so an upgrade replaces it instead of installing beside it`,
    );
  }
  // Per-machine, so one install serves every account on the machine and the
  // login task belongs to the system, not to one person.
  asserts("installer/drive.wxs", /Scope="perMachine"/, "installs per machine");
  // An upgrade in place, not a second copy beside the first.
  asserts("installer/drive.wxs", /<MajorUpgrade/, "upgrades an installed Drive in place");
  asserts(
    "installer/drive.wxs",
    /UpgradeCode="[0-9A-F-]{36}"/,
    "carries the UpgradeCode a MajorUpgrade needs",
  );
});

test("the MSI puts both binaries on the system PATH", () => {
  const component = MSI.split("\n").find((l) => l.includes('Id="PathEnv"'));
  assert.ok(component, "drive.wxs must carry an Environment element for PATH");
  const block = MSI.slice(MSI.indexOf('Id="PathEnv"'), MSI.indexOf('Id="PathEnv"') + 400);
  assert.match(block, /Name="PATH"/, "the environment variable is PATH");
  assert.match(block, /Value="\[INSTALLFOLDER\]"/, "and it is the install directory");
  assert.match(block, /Part="last"/, "appended, so an existing PATH is not replaced");
  assert.match(block, /System="yes"/, "the machine PATH, so it serves every prompt");
});

test("the MSI registers the login task from drive#153 and removes it on uninstall", () => {
  // The same stock schtasks.exe the CLI calls (cmd/drive/windows.go), with the
  // same /Create /F /SC ONLOGON /TN drive-mount vector its tests pin.
  asserts(
    "installer/drive.wxs",
    /schtasks\.exe&quot; \/Create \/F \/SC ONLOGON \/TN drive-mount/,
    "registers the ONLOGON task named drive-mount",
  );
  asserts(
    "installer/drive.wxs",
    /schtasks\.exe&quot; \/Delete \/F \/TN drive-mount/,
    "removes that same task on uninstall",
  );
  asserts(
    "installer/drive.wxs",
    /\[#drive\.exe\]&quot; mount/,
    "the task runs the installed drive.exe mount, the command drive mount runs",
  );
  // A deferred, non-impersonated custom action: the task is a per-machine
  // object, so it needs the system's privilege and not the installing user's.
  asserts("installer/drive.wxs", /Execute="deferred"/, "the schtasks actions are deferred");
  asserts("installer/drive.wxs", /Impersonate="no"/, "and run as the system");
  asserts(
    "installer/drive.wxs",
    /DllEntry="WixQuietExec64"/,
    "the quiet-exec action is the Util extension's own, not installer code of ours",
  );
  asserts(
    "installer/drive.wxs",
    /BinaryRef="Wix4UtilCA_X64"/,
    "and it comes from the Util extension's 64-bit binary",
  );
  // A logon task with no /RU runs as the account that created it, and the
  // deferred action creates it as LocalSystem: without these the drive would
  // mount as SYSTEM with SYSTEM's home and no person's keys.
  asserts(
    "installer/drive.wxs",
    /\/RU &quot;\[DRIVE_LOGON_USER\]&quot; \/IT/,
    "the task runs as the person who installed, in their own session",
  );
  asserts(
    "installer/drive.wxs",
    /<SetProperty Id="DRIVE_LOGON_USER" Value="\[LogonUser\]"/,
    "and that person is the MSI's own LogonUser, captured before the deferred action runs",
  );
  // Install only when installing, remove only when removing or upgrading: a
  // repair must not wipe the task, and an install must not delete one.
  asserts(
    "installer/drive.wxs",
    /Action="CreateLoginTask"[^>]*Condition="NOT Installed AND NOT REMOVE"/,
    "the task is created on a fresh install only",
  );
  asserts(
    "installer/drive.wxs",
    /Action="DeleteLoginTask"[^>]*Condition="\(REMOVE~=&quot;ALL&quot;\) OR \(Upgrade=1\)"/,
    "and removed on a full uninstall or an upgrade",
  );
});

test("the bundle carries a bootstrapper application and its own licence link", () => {
  asserts(
    "installer/bundle.wxs",
    /<BootstrapperApplication>/,
    "a bundle needs a bootstrapper application; /quiet skips it",
  );
  asserts(
    "installer/bundle.wxs",
    /Theme="hyperlinkLicense"/,
    "and it is WiX's own standard one, from the Bal extension",
  );
  // The bundle is a logon installer a person may double click, so its licence
  // link must be a real page on our own site, not a vendor's or a rival's.
  const licence = BUNDLE.match(/LicenseUrl="([^"]+)"/)?.[1];
  assert.ok(licence, "the bundle must carry a licence URL");
  assert.match(
    licence,
    /^https:\/\/github\.com\/Nishfleet\/drive\//,
    `the licence link must be one of our own pages, got ${licence}`,
  );
});

test("the bundle brings WinFsp from WinFsp's own release, never a vendored copy", () => {
  asserts(
    "installer/bundle.wxs",
    /DownloadUrl="https:\/\/github\.com\/winfsp\/winfsp\/releases\/download\/[^"]+\/winfsp-[^"]+\.msi"/,
    "WinFsp's MSI is downloaded from WinFsp's own GitHub release",
  );
  // Compressed="no" is what keeps WinFsp a payload the bundle downloads
  // rather than a second vendor's bytes embedded in ours.
  asserts(
    "installer/bundle.wxs",
    /Id="WinFsp"[\s\S]{0,600}?Compressed="no"/,
    "WinFsp is not embedded in our bundle, only fetched",
  );
  // No binary of WinFsp's ships in this repository: the tree carries the URL.
  const tracked = execFileSync("git", ["ls-files", "installer"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  assert.ok(tracked.length > 0, "the installer sources are tracked");
  for (const file of tracked) {
    assert.doesNotMatch(
      file,
      /\.msi$|\.exe$/,
      `installer/${file} is a built artifact; only the sources are committed`,
    );
  }
  // One WinFsp version across the two files that name it: the bundle's chain
  // and the CI job's download must not drift apart.
  const bundleVersion = BUNDLE.match(/winfsp\/releases\/download\/[^/]+\/winfsp-([^"]+)\.msi/)?.[1];
  const workflowVersion = WORKFLOW.match(/WINFSP_VERSION:\s*"?([\d.]+)"?/)?.[1];
  assert.ok(bundleVersion, "the bundle names a WinFsp version");
  assert.equal(workflowVersion, bundleVersion, "the CI job downloads that same WinFsp version");
  asserts(
    "installer/windows-msi.yml",
    new RegExp(
      `WINFSP_MSI_URL:\\s*"?https://github\\.com/winfsp/winfsp/releases/download/[^"]+/winfsp-${bundleVersion}\\.msi`,
    ),
    "and from that same release URL",
  );
  // A downloaded payload needs an integrity pin. WiX v4's MsiPackage has no
  // Hash attribute (the compiler rejects it), so Burn's own Authenticode check
  // is one half and the committed digest is the other; a digest that was
  // silently dropped would leave only the signature, so it is asserted.
  assert.doesNotMatch(
    BUNDLE,
    /SuppressSignatureValidation="yes"/,
    "Burn must keep validating the downloaded WinFsp MSI's Authenticode signature",
  );
  const digest = WORKFLOW.match(/WINFSP_MSI_SHA256:\s*"?([0-9a-f]{64})"?/)?.[1];
  assert.ok(digest, "the CI job must pin the digest of the WinFsp MSI it downloads");
  asserts(
    "installer/windows-msi.yml",
    /Get-FileHash -Path installer\\winfsp\.msi -Algorithm SHA256/,
    "and check the download against it",
  );
});

test("the bundle chains WinFsp before Drive, and Drive after it", () => {
  const winfsp = BUNDLE.indexOf('Id="WinFsp"');
  const drive = BUNDLE.indexOf('Id="Drive"');
  assert.ok(winfsp > 0 && drive > winfsp, "WinFsp is installed first, Drive second");
  asserts("installer/bundle.wxs", /Vital="yes"/, "both packages are vital: no silent half-install");
  // WinFsp is its own package: it must survive Drive's uninstall.
  asserts(
    "installer/bundle.wxs",
    /Id="WinFsp"[\s\S]{0,600}?Permanent="no"/,
    "WinFsp is installed as a normal package, not a permanent part of the bundle",
  );
});

test("the winget manifest makes WinFsp a package dependency", () => {
  const dir = "installer/winget/manifests/Nishfleet/Nishfleet.Drive/1.0.0/";
  const files = readdirSync(new URL(`../${dir}`, import.meta.url)).sort();
  assert.deepEqual(
    files,
    ["Nishfleet.Drive.installer.yaml", "Nishfleet.Drive.locale.en-US.yaml", "Nishfleet.Drive.yaml"],
    "the manifest is the three files winget-pkgs holds for a package version",
  );
  const installer = read(`${dir}Nishfleet.Drive.installer.yaml`);
  assert.match(
    installer,
    /PackageDependencies:\n\s+- PackageIdentifier: WinFsp\.WinFsp/,
    "winget installs WinFsp.WinFsp before Drive, so the driver is never a manual step",
  );
  // InstallModes and switches are what `winget install` reads for a silent run.
  assert.match(installer, /InstallModes:\n\s+- silent/, "the manifest declares a silent install");
  assert.match(
    installer,
    /Silent: "\/quiet \/norestart"/,
    "and the quiet switch a person's machine would use",
  );
  // The hash is a placeholder until a signed release exists. A build that is
  // published with a zero hash must fail, so the placeholder is one the CI
  // job and the release process overwrite before any manifest is submitted.
  assert.match(installer, /InstallerSha256: 0{64}/, "no release hash is invented here");
  asserts(
    "installer/windows-msi.yml",
    /winget validate/,
    "the CI job is what runs winget validate, the only thing that can prove this manifest",
  );
});

test("the job proves both routes: the MSI with msiexec /qn, and the bundle winget runs", () => {
  // Every msiexec call passes its args as an array, and each one
  // writes its own verbose log (/l*v) so a red run's only evidence
  // is the exit code — and now the log itself (drive#369).
  asserts(
    "installer/windows-msi.yml",
    /msiexec\.exe[^\n]*-ArgumentList @\('\/i',/,
    "the Drive MSI is installed silently with msiexec /qn, arguments as an array",
  );
  asserts(
    "installer/windows-msi.yml",
    /msiexec\.exe[^\n]*-ArgumentList @\('\/x',/,
    "and uninstalled the same silent way",
  );
  asserts(
    "installer/windows-msi.yml",
    /msiexec\.exe[^\n]*'\/l\*v'/,
    "every msiexec call writes its own verbose Windows Installer log (/l*v) (drive#369)",
  );
  asserts(
    "installer/windows-msi.yml",
    /msiexec\.exe[^\n]*-ArgumentList @\('\/i',[^\n]*installer\\install\.log/,
    "the Drive install names its log, install.log, and uploads it on failure",
  );
  asserts(
    "installer/windows-msi.yml",
    /msiexec\.exe[^\n]*-ArgumentList @\('\/i',[^\n]*installer\\winfsp-install\.log/,
    "the WinFsp install names its log",
  );
  asserts(
    "installer/windows-msi.yml",
    /msiexec\.exe[^\n]*-ArgumentList @\('\/x',[^\n]*installer\\uninstall\.log/,
    "and the uninstall names its log",
  );
  asserts(
    "installer/windows-msi.yml",
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/,
    "the log is uploaded as an artifact, pinned to the pinned byte hash",
  );
  asserts(
    "installer/windows-msi.yml",
    /if: failure\(\)/,
    "and the upload is gated on failure, so a green run uploads nothing",
  );
  asserts(
    "installer/windows-msi.yml",
    /Start-Process installer\\drive-setup\.exe -Wait -PassThru -ArgumentList/,
    "the bundle route starts the stock drive-setup.exe",
  );
  assert.ok(
    WORKFLOW.indexOf("the route winget install takes") > 0,
    "the bundle route must be labelled as the winget route, so the two are not confused",
  );
});

test("the Windows job is written to run on windows-latest and calls the tools directly", () => {
  asserts("installer/windows-msi.yml", /runs-on: windows-latest/, "runs on a Windows runner");
  for (const tool of [
    "dotnet tool install --global wix",
    "go build -o installer\\drive.exe ./cmd/drive",
    "wix build installer\\drive.wxs",
    "wix build installer\\bundle.wxs",
    "msiexec.exe",
    "Start-ScheduledTask",
    "winget validate",
  ]) {
    if (tool === "Start-ScheduledTask") {
      // The task is read with the Task Scheduler cmdlet the OS ships, not a
      // helper script of ours.
      asserts(
        "installer/windows-msi.yml",
        /Get-ScheduledTask/,
        "reads the login task with Task Scheduler",
      );
      continue;
    }
    assert.ok(
      WORKFLOW.includes(tool),
      `the job must call the tool itself (${tool}); a helper script is banned`,
    );
  }
  // Every step runs the stock tool in the step's own shell block: the repo
  // bans a new script anywhere, and a .ps1 or .sh beside this file would be
  // one.
  const tracked = execFileSync("git", ["ls-files", "installer"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  for (const file of tracked) {
    assert.doesNotMatch(
      file,
      /\.(sh|ps1|bat|cmd|mjs|js|ts)$/,
      `installer/${file} is a script; AGENTS.md bans a new one`,
    );
  }
});

test("the Windows job is not in .github/, and is byte-identical when it lands there", () => {
  // The agent worker App has no Workflows write, so a push that touches
  // .github/workflows/ is rejected by GitHub. The job therefore sits beside
  // its sources, and the reason is in the file's own header, so whoever moves
  // it does not have to read the history to find out why it moved.
  const workflowDir = new URL("../.github/workflows/", import.meta.url);
  const shippedPath = new URL("windows-msi.yml", workflowDir);
  if (!existsSync(shippedPath)) {
    // Not landed yet: the job is still dormant, and the file says why.
    assert.match(
      WORKFLOW,
      /refusing to allow a GitHub App to create or/,
      "the file must carry the exact rejection it works around",
    );
    assert.match(
      WORKFLOW,
      /without `workflows` permission/,
      "and the reason GitHub gives: the App has no Workflows write",
    );
    asserts(
      "installer/windows-msi.yml",
      /\.github\/workflows\/windows-msi\.yml/,
      "and name where it has to land",
    );
    return;
  }
  // Landed: the copy that runs must be the copy that was reviewed, so the two
  // are compared byte for byte rather than left to drift.
  assert.equal(
    readFileSync(shippedPath, "utf8"),
    WORKFLOW,
    ".github/workflows/windows-msi.yml has drifted from installer/windows-msi.yml",
  );
});

test("the scoreboard carries the Windows row and the docs gain the installer", () => {
  const scoreboard = read("docs/scoreboard.md");
  const row = scoreboard.split("\n").find((l) => l.startsWith("| Windows install and mount |"));
  assert.ok(row, "docs/scoreboard.md must carry the Windows row");
  const cells = row.split("|").map((c) => c.trim());
  assert.equal(cells.length, 7, `five columns: ${row}`);
  // No CI run has produced a figure yet, so the row is honest about that: the
  // FAQ only publishes an answer for a measured win (src/docs.js, and
  // test/docs.test.mjs refuses an unmeasured row), so this row must not claim
  // one.
  assert.ok(
    cells[3].startsWith("not yet measured"),
    `the row must not claim a measurement no run has made: ${cells[3]}`,
  );
  assert.equal(cells[4], "not yet measured", "and its verdict agrees");
  assert.match(cells[5], /#154/, "and it names the issue that will produce the figure");
  // The docs pages a person reads must say the same thing, so the site cannot
  // claim a Windows installer that has not shipped.
  asserts("docs-site/limits.md", /Windows installs with an MSI/, "the limits page names the MSI");
  asserts("docs-site/limits.md", /unsigned/, "and says the builds are unsigned");
});
