export const VERSION_HISTORY = "Version history is not in version 1.";
export const NOT_OPEN = "The drive is not open yet. Sign-ups on the pricing page go to a waitlist.";

export const PLATFORMS = "Storagebun runs on macOS and Linux today. Windows is not ready yet.";

export const VERSION_HISTORY_PROMISES = Object.freeze([
  /every save keeps a version/i,
  /keeps a version/i,
  /version history is included/i,
  /every version of a file/i,
  /restore any earlier version/i,
]);

export const V1_PLATFORMS = Object.freeze(["macOS", "Linux"]);

export const OUT_OF_V1_PLATFORM_WORDS = Object.freeze([
  { label: "Windows", pattern: /\bWindows\b/ },
  { label: "MSI", pattern: /\bMSI\b/ },
  { label: "WinFsp", pattern: /\bWinFsp\b/i },
]);

export const OUT_OF_V1_PLATFORM_DENIALS = Object.freeze([
  /not in version 1/i,
  /not a version 1/i,
  /not in v1\b/i,
]);

export const OUT_OF_V1_MSI_DENIALS = Object.freeze([
  ...OUT_OF_V1_PLATFORM_DENIALS,
  /not ready yet/i,
  /not yet released/i,
  /no published release/i,
  /\bunsigned\b/i,
]);
