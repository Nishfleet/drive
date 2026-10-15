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
  const palette = /** @type {HTMLDialogElement | null} */ (document.getElementById("palette"));
  const shortcuts = /** @type {HTMLDialogElement | null} */ (document.getElementById("shortcuts"));
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById("palette-input"));
  const listEl = document.getElementById("palette-list");
  if (palette === null || shortcuts === null || input === null || listEl === null) return;
  const dialog = palette;
  const help = shortcuts;
  const field = input;
  const results = listEl;

  /** @typedef {{label: string, hint: string, run: () => void}} Command */
  /** @param {string} href */
  const go = (href) => () => {
    location.href = href;
  };
  /** @type {Command[]} */
  const COMMANDS = [
    { label: "Home", hint: "Page", run: go("/home") },
    { label: "Files", hint: "Page", run: go("/files") },
    { label: "Usage", hint: "Page", run: go("/usage") },
    { label: "Billing", hint: "Page", run: go("/billing") },
    { label: "Devices", hint: "Page", run: go("/devices") },
    { label: "Webhooks", hint: "Page", run: go("/webhooks") },
    { label: "Get started", hint: "Page", run: go("/get-started") },
    { label: "Docs", hint: "Page", run: go("/docs/") },
    { label: "Top up", hint: "Command", run: go("/billing#topup-form") },
    { label: "Add a device", hint: "Command", run: go("/devices") },
    {
      label: "Keyboard shortcuts",
      hint: "Command",
      run: () => {
        help.showModal();
      },
    },
    {
      label: "Sign out",
      hint: "Command",
      run: () => {
        const out = document.getElementById("nav-signout");
        if (out !== null && !out.hidden) out.click();
        else location.href = "/signin";
      },
    },
  ];

  /** @type {Command[]} */
  let shown = [];
  let active = 0;
  let asked = 0;

  function draw() {
    results.replaceChildren();
    shown.forEach((command, index) => {
      const item = document.createElement("div");
      item.id = `palette-option-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === active));
      const name = document.createElement("span");
      name.textContent = command.label;
      const hint = document.createElement("small");
      hint.textContent = command.hint;
      item.appendChild(name);
      item.appendChild(hint);
      item.addEventListener("click", () => choose(index));
      results.appendChild(item);
    });
    field.setAttribute("aria-activedescendant", shown.length ? `palette-option-${active}` : "");
  }

  /** @param {number} index */
  function choose(index) {
    const command = shown[index];
    if (command === undefined) return;
    dialog.close();
    command.run();
  }

  /** @param {string} query */
  async function filesFor(query) {
    const ticket = ++asked;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=5`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok || ticket !== asked) return;
      const payload = await response.json();
      if (!Array.isArray(payload.results)) return;
      /** @type {Command[]} */
      const found = payload.results.map((/** @type {{name: string, path: string}} */ row) => ({
        label: row.name,
        hint: "File",
        run: go(`/files?folder=${encodeURIComponent(row.path.replace(/\/[^/]*$/, "") || "/")}`),
      }));
      shown = [...shown, ...found];
      draw();
    } catch {}
  }

  function update() {
    const query = field.value.trim().toLowerCase();
    shown = COMMANDS.filter((command) => command.label.toLowerCase().includes(query));
    active = 0;
    draw();
    if (query.length >= 2) void filesFor(query);
  }

  function open() {
    if (dialog.open) return;
    field.value = "";
    update();
    dialog.showModal();
    field.focus();
  }

  field.addEventListener("input", update);
  field.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      active = (active + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
      draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  help.addEventListener("click", (event) => {
    if (event.target === help) help.close();
  });
  document.getElementById("shortcuts-close")?.addEventListener("click", () => help.close());
  document.getElementById("palette-open")?.addEventListener("click", open);

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
      return;
    }
    const target = event.target;
    const typing =
      target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    if (event.key === "?" && !typing && !dialog.open && !help.open) {
      event.preventDefault();
      help.showModal();
    }
  });
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
