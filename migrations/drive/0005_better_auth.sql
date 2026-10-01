-- Better Auth's four tables, on the customer database (drive issue #181,
-- split from #161). The statements below are exactly what Better Auth's own
-- `getMigrations()` compiles for the auth configuration in src/auth.js, and
-- test/auth.test.mjs re-runs that generator and fails when this file drifts —
-- so a Better Auth upgrade that changes the schema fails here rather than at
-- the first sign-in.
--
-- These are the names Better Auth's adapter queries ("user", "session",
-- "account", "verification"), so there is no table prefix and no hand-written
-- alias: the Kysely dialect that talks to D1 and the SQLite engine the tests
-- run both see the same four tables the same way.
--
-- Purely additive, so a rollback of the code leaves the tables in place and
-- the previous Worker version is untouched by them (drive's D1 rule: code
-- rolls back, data does not).
create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date, "updatedAt" date);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");