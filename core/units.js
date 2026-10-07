// Shared time units. This file imports nothing, so a module that needs a day
// can take it without pulling Better Auth. Putting DAY_MS on core/auth.js
// (issue #583's first pass) made core/files.js import Better Auth and grew
// the site Worker past the 3,520,000-byte budget.

export const DAY_MS = 24 * 60 * 60 * 1000;
