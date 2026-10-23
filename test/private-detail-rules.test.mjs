import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const TOML = readFileSync(
  new URL("../.github/gitleaks-private-detail.toml", import.meta.url),
  "utf8",
);
const CI = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

/**
 * A parsed `[[rules]]` block of the private-detail gitleaks config.
 * @typedef {{ id: string, regex: string, keywords: string[] }} Rule
 */

/**
 * @param {string} block
 * @returns {Rule}
 */
const parseRule = (block) => {
  const id = block.match(/^id = "(.+)"$/m)?.[1];
  assert.ok(id, "every rules block carries an id");
  const regex = block.match(/regex = '''(.+?)'''(?: #.*)?$/m)?.[1];
  assert.ok(regex, `rule ${id} carries a single-line regex`);
  const keywords = block.match(/keywords = \[(.+)\]/m)?.[1];
  assert.ok(keywords, `rule ${id} carries a keyword prefilter`);
  return {
    id,
    regex,
    keywords: keywords.split(",").map((k) => k.trim().replaceAll('"', "")),
  };
};

/** @type {Rule[]} */
const rules = TOML.split(/^\[\[rules\]\]$/m)
  .slice(1)
  .map(parseRule);

const allowlist = TOML.slice(TOML.indexOf("[[allowlists]]"));

/**
 * The Go regexp sourced from a rule, as JS can compile it.
 * @param {Rule} rule
 */
function compiled(rule) {
  let regex = rule.regex;
  let flags = "";
  if (regex.startsWith("(?i)")) {
    regex = regex.slice(4);
    flags = "i";
  }
  return new RegExp(regex, flags);
}

/**
 * What gitleaks answers for a line: the keyword prefilter is case-insensitive,
 * then the regex decides.
 * @param {Rule} rule
 * @param {string} line
 */
function detects(rule, line) {
  const lower = line.toLowerCase();
  return rule.keywords.some((k) => lower.includes(k.toLowerCase())) && compiled(rule).test(line);
}

/** @type {Record<string, { bad: string[], clean: string[] }>} */
const SAMPLES = {
  "private-home-path": {
    bad: [
      "run it under home/nish/workspaces/agent-worktrees/orch-drive-1 first",
      "see /home/nish/AGENTS.md for the contract",
    ],
    clean: ["run it under home/jane/workspaces first", "the repo sits beside the other clones"],
  },
  "private-fleet-seats-config": {
    bad: ["login lives in ~/.config/fleet-ops/seats/seat-b.env"],
    clean: ["login lives in ~/.config/gh/hosts.yml"],
  },
  "private-tailscale-ipv4": {
    bad: ["health check answers at http://100.101.3.4/health", "host 100.127.255.254 answers"],
    clean: ["health check answers at http://100.50.3.4/health", "the private net is 10.1.2.3"],
  },
  "private-tailscale-name": {
    bad: ["the runner is reachable at vps-agent-2.nishfleet.ts.net"],
    clean: ["the runner is reachable at vps-agent-2.nishfleet.example.com"],
  },
  "private-cloudflare-account-id": {
    bad: [
      "CLOUDFLARE_ACCOUNT_ID: 0123456789abcdef0123456789abcdef",
      "account-id = 89abcdef0123456789abcdef01234567",
    ],
    clean: [
      "CLOUDFLARE_ACCOUNT_ID is set in the environment",
      "the table carries hex ids like 0123456789abcdef0123456789abcdef with an account id name pages away",
    ],
  },
};

test("every rule in the rules file is held to a known-bad and a clean sample", () => {
  assert.ok(rules.length >= 5, "the private-detail rules all parse");
  for (const rule of rules) {
    assert.match(rule.id, /^private-/, "every rule scopes itself to private detail");
    const samples = SAMPLES[rule.id];
    assert.ok(samples, `${rule.id} has samples in test/private-detail-rules.test.mjs`);
    assert.ok(samples.bad.length >= 1 && samples.clean.length >= 1);
  }
});

test("the rules match every known-bad sample", () => {
  for (const rule of rules) {
    for (const line of SAMPLES[rule.id].bad) {
      assert.ok(detects(rule, line), `${rule.id} misses: ${line}`);
    }
  }
});

test("the rules never match a clean sample", () => {
  for (const rule of rules) {
    for (const line of SAMPLES[rule.id].clean) {
      assert.ok(!compiled(rule).test(line), `${rule.id} falsely flags: ${line}`);
    }
  }
});

test("the scan pass uses these rules and the allowlist exempts the rules file itself", () => {
  assert.match(CI, /gitleaks git \. --config \.github\/gitleaks-private-detail\.toml/);
  const allowRe = allowlist.match(/paths = \['''(.+?)'''\]/m)?.[1];
  assert.ok(allowRe, "the allowlist names the paths it exempts");
  assert.match(
    ".github/gitleaks-private-detail.toml",
    new RegExp(allowRe, "m"),
    "the allowlist exempts the file carrying the rules",
  );
});
