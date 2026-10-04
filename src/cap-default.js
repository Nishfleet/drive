// The customer's spending-cap default (drive#464). One number, imported by
// billing (the product config) and emails (which cannot import billing.js:
// billing → status → auth → email-send → emails). Change it here.

export const DEFAULT_CAP_USD = 20;
