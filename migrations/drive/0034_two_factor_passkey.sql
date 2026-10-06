-- Better Auth's two-factor and passkey plugins, on the customer database
-- (drive issue #524). Turning the plugins on in core/auth.js makes every
-- Worker instance read and write these tables, so they land with the code
-- that reads them: the schema-mismatch check better-auth runs on first use
-- refuses a plugin whose tables are missing, and a deployed D1 that lags the
-- code is a sign-in that cannot start rather than one that half-works.
-- Numbered 0034, the next free prefix: 0031 is the highest on origin/main and 0032 and 0033 belong to other open PRs.
--
-- The statements below are exactly what Better Auth's own `getMigrations()`
-- compiles for the plugin set core/auth.js carries (magic link, two-factor
-- TOTP with backup codes, passkeys), minus the tables and columns 0005 and
-- 0011 already created and the one new column on `user`, which is the ALTER
-- below: the planner emits `twoFactorEnabled` inside its fresh-database
-- schema statement for that table, and a deployed database cannot re-run it.
-- The pin in test/auth.test.mjs re-runs the generator against a database built
-- from the shipped files and fails when this drifts — so a library upgrade
-- that changes the schema fails here rather than at the first sign-in.
--
-- Purely additive, so a rollback of the code leaves the tables in place and
-- the previous Worker version is untouched by it (drive's D1 rule: code
-- rolls back, data does not). `twoFactorEnabled` is nullable on purpose: no
-- default, so every existing row reads as second-factor off, which is the
-- truth about accounts that never turned it on.
alter table "user" add column "twoFactorEnabled" integer;
create table "twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);
create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);
create index "twoFactor_secret_idx" on "twoFactor" ("secret");
create index "twoFactor_userId_idx" on "twoFactor" ("userId");
create index "passkey_userId_idx" on "passkey" ("userId");
create index "passkey_credentialID_idx" on "passkey" ("credentialID");
