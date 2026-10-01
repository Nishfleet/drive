// Type declarations for the shared src modules
// This allows TypeScript to resolve imports from workers/api/src to src/*

import type { D1Database } from "@cloudflare/workers-types";

/** Better Auth instance type */
export type Auth = {
  api: {
    getSession(options: {
      headers: Headers;
    }): Promise<{ user: { id: string; name: string; email: string } } | null>;
    signInMagicLink(options: { body: { email: string }; headers: Headers }): Promise<unknown>;
    magicLinkVerify(options: {
      query: { token: string };
      headers: Headers;
      asResponse?: boolean;
    }): Promise<Response | unknown>;
  };
};

/** Email binding type */
export type EmailBinding = {
  send(options: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
};

/** auth.js exports */
export const AUTH_COOKIE_PREFIX: "drive";
export const SIGNIN_LINK_TTL_SECONDS: 600;
export const SESSION_TTL_SECONDS: number;
export const AFTER_SIGNIN_PATH: "/files";
export const SIGNIN_LINK_PATH: "/api/signin/verify";

export function createAuth(options: {
  database: D1Database | object;
  secret: string;
  baseURL: string;
  sendLink: (link: { to: string; url: string }) => Promise<unknown>;
}): Auth;

export function authFor(env: {
  DRIVE_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
}): Auth | null;

export function signinLinkEmail(url: string): {
  subject: string;
  text: string;
  html: string;
  saved: null;
};

export function sessionAccount(
  _request: Request,
  _auth: Auth | null | undefined,
): Promise<{ id: string; name: string; email: string } | null>;

/** messages.js exports */
export function failureMessage(key: string): string;

/** status.js exports */
export function signedInAccount(
  _request: Request,
  _auth:
    | {
        api: {
          getSession: (options: {
            headers: Headers;
          }) => Promise<{ user: { id: string; name: string; email: string } } | null>;
        };
      }
    | null
    | undefined,
): Promise<{ id: string; name: string; email: string } | null>;

/** email-send.js exports */
export function sendEmail(
  binding: EmailBinding,
  options: {
    to: string;
    kind: string;
    from: string;
    rendered: { subject: string; text: string; html: string; saved: string | null };
  },
): Promise<unknown>;
export function isSameOriginRequest(request: Request): boolean;
