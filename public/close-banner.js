(() => {
  if (typeof document === "undefined") return;

  const CLOSE_ENDPOINT = "/api/account/close";
  const BANNER_ID = "close-banner";
  const WHAT_ID = "close-banner-what";
  const CANCEL_ID = "close-banner-cancel";
  const USAGE_PAGE = "/usage";

  /**
   * The banner's own element, or null on a page that does not carry one. A
   * page without it is not a signed-in page, and the script returns without
   * touching anything rather than throwing on a null reference.
   * @returns {HTMLElement | null}
   */
  const bannerEl = () => document.getElementById(BANNER_ID);

  /**
   * The endpoint's `{purgeOn}` placeholder, filled with the payload's date.
   * The module writes the sentence with one placeholder and the payload carries
   * the one value for it, so a payload that ever gained a second placeholder
   * would leave its braces in the sentence rather than show an empty gap.
   * @param {string} sentence
   * @param {string} purgeOn
   * @returns {string}
   */
  const fill = (sentence, purgeOn) => sentence.replace(/\{purgeOn\}/g, () => purgeOn);

  /**
   * Show the banner for a closing account. The text is set and then the region
   * is revealed, the same order the usage page's status region uses
   * (public/usage.html sayUnreachable), so the two status regions on that page
   * are read the same way.
   * @param {{state: string, purgeOn: unknown, copy: Record<string, string>}} payload
   */
  const reveal = (payload) => {
    const banner = bannerEl();
    if (!banner) return;
    const what = document.getElementById(WHAT_ID);
    const cancel = document.getElementById(CANCEL_ID);
    const sentence = fill(payload.copy.pendingWhat, String(payload.purgeOn));
    if (!banner.hidden && what && what.textContent === sentence) return;
    if (what) {
      what.textContent = sentence;
    }
    if (cancel) {
      cancel.textContent = payload.copy.pendingCancel;
      cancel.setAttribute("href", USAGE_PAGE);
    }
    banner.hidden = false;
  };

  const read = () => {
    fetch(CLOSE_ENDPOINT, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((payload) => {
        if (!payload || typeof payload !== "object") return;
        if (payload.state !== "closed") return;
        if (payload.purgedAt !== null && payload.purgedAt !== undefined) return;
        if (!payload.copy || typeof payload.copy !== "object") return;
        reveal(payload);
      })
      .catch((_error) => {});
  };

  if (!bannerEl()) return;
  read();
  window.setInterval(read, 60000);
})();

(() => {
  if (typeof document === "undefined") return;
  const chip = document.getElementById("balance-chip");
  const amount = document.getElementById("balance-chip-amount");
  const menu = /** @type {HTMLDetailsElement | null} */ (document.getElementById("account-menu"));
  if (chip === null || amount === null || menu === null) return;
  const chipEl = chip;
  const amountEl = amount;

  const sharedSession = document.body.dataset.signout === "shared";
  const navSignin = document.getElementById("nav-signin");
  const navSignout = document.getElementById("nav-signout");
  const navSignoutAll = document.getElementById("nav-signout-all");

  /** @param {boolean} signedIn */
  function showSessionNav(signedIn) {
    if (navSignin !== null) navSignin.hidden = signedIn;
    if (navSignout !== null) navSignout.hidden = !signedIn;
    if (navSignoutAll !== null) navSignoutAll.hidden = !signedIn;
  }

  /** @param {string} step */
  async function postSignout(step) {
    const response = await fetch("/api/signin", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ step }),
    }).catch(() => null);
    if (response?.ok) location.reload();
  }

  if (sharedSession) {
    navSignout?.addEventListener("click", () => void postSignout("signout"));
    navSignoutAll?.addEventListener("click", () => void postSignout("signout-all"));
  }

  async function readBalance() {
    try {
      const response = await fetch("/api/balance", { headers: { accept: "application/json" } });
      if (sharedSession) showSessionNav(response.status !== 401);
      if (!response.ok) return;
      const payload = await response.json();
      if (typeof payload.balance !== "string") return;
      amountEl.textContent = payload.balance;
      chipEl.hidden = false;
    } catch {}
  }

  document.addEventListener("click", (event) => {
    if (menu.open && !menu.contains(/** @type {Node} */ (event.target))) menu.open = false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });

  void readBalance();
})();

(() => {
  if (typeof document === "undefined") return;
  const host = document.getElementById("toasts");
  if (host === null) return;
  const stack = host;
  const quiet = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.addEventListener("toast", (event) => {
    const text = /** @type {CustomEvent<{text?: string}>} */ (event).detail?.text;
    if (typeof text !== "string" || text === "") return;
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = text;
    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  });

  const DURATION = 240;
  const NUMBER = /\d[\d,]*(?:\.\d+)?/;
  /** @type {WeakMap<HTMLElement, string>} */
  const written = new WeakMap();

  /** @param {HTMLElement} el */
  function countUp(el) {
    const text = el.textContent ?? "";
    const found = NUMBER.exec(text);
    if (found === null || quiet()) return;
    const target = Number(found[0].replaceAll(",", ""));
    if (!(target > 0)) return;
    const decimals = found[0].split(".")[1]?.length ?? 0;
    const grouped = found[0].includes(",");
    const start = performance.now();
    /** @param {number} now */
    const step = (now) => {
      const done = Math.max(0, Math.min(1, (now - start) / DURATION));
      const value = (target * done).toFixed(decimals);
      const shown = grouped
        ? Number(value).toLocaleString("en-US", { minimumFractionDigits: decimals })
        : value;
      const next = text.replace(found[0], shown);
      written.set(el, next);
      el.textContent = next;
      if (done < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const watcher = new MutationObserver((records) => {
    for (const record of records) {
      const el = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      if (el?.dataset.count !== undefined && el.textContent !== written.get(el)) countUp(el);
    }
  });
  for (const el of document.querySelectorAll("[data-count]")) {
    watcher.observe(el, { childList: true, characterData: true, subtree: true });
  }
})();

export {};
