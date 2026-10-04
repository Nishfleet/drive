// The pending-close banner (drive issue #424). One script, loaded by every
// signed-in page, so the banner cannot drift between them.
//
// It is a static asset served next to the pages that load it, so it cannot
// import src/account-close.js the way the Worker does. The words come from
// where every other page's words come from: the endpoint's own payload. GET
// /api/account/close answers `{state, purgeOn, copy}`, and `copy` is the
// CLOSE_COPY object in src/account-close.js, so the sentence on screen is the
// module's and the date beside it is the date the nightly cron will actually
// purge on. This file carries no sentence and no date arithmetic of its own,
// which is what test/close-banner.test.mjs holds it to.
//
// Three outcomes, and the third is the one that must be quiet:
//   - a 401 or any other failed read: this browser has no signed-in account, or
//     the service is unreachable. Either way the page's own content is the
//     truth, so the banner stays hidden and nothing is announced.
//   - `state === "active"`: the account is not closing. Banner stays hidden.
//   - `state === "closed"`: reveal it, with the purge date and a Cancel link.
//
// The link is a real link to /usage, the page where the close and the cancel
// both live and where the person types their email to confirm. It is a link and
// not a button that posts, because cancelling is a confirmation step: the
// endpoint wants the account's email typed back (src/account-close.js
// requireMatchingEmail), and that form is already on /usage. A button here
// would either skip the confirmation or open a second copy of it.

(() => {
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
  const fill = (sentence, purgeOn) => sentence.replace(/\{purgeOn\}/g, purgeOn);

  /**
   * Show the banner for a closing account. The element is revealed before its
   * text is set, because a `role="status"` region filled while still hidden is
   * not announced by every screen reader — the same rule the usage page's
   * status region follows.
   * @param {{state: string, purgeOn: unknown, copy: Record<string, string>}} payload
   */
  const reveal = (payload) => {
    const banner = bannerEl();
    if (!banner) return;
    const what = document.getElementById(WHAT_ID);
    const cancel = document.getElementById(CANCEL_ID);
    if (what) {
      what.textContent = fill(payload.copy.pendingWhat, String(payload.purgeOn));
    }
    if (cancel) {
      // The link's own words are the payload's too, and its href is the page
      // that holds the cancel form.
      cancel.textContent = payload.copy.pendingCancel;
      cancel.setAttribute("href", USAGE_PAGE);
    }
    banner.hidden = false;
  };

  /**
   * Read the close state and reveal the banner only when the account is
   * actually closing. A failed read, a 401, an unparseable body, or a payload
   * without the words all leave the page exactly as it was.
   */
  const read = () => {
    fetch(CLOSE_ENDPOINT, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((payload) => {
        if (!payload || typeof payload !== "object") return;
        if (payload.state !== "closed") return;
        if (!payload.copy || typeof payload.copy !== "object") return;
        reveal(payload);
      })
      .catch(() => {
        // A banner that could not be read stays hidden. The page's own content
        // is still correct, and a close that is in flight is also shown in the
        // account's email, so nothing is lost by saying nothing here.
      });
  };

  if (!bannerEl()) return;
  read();
  // A close can start on another tab, or the same page can be left open across
  // the close, so the banner is re-read on the same interval the usage page
  // re-reads its month. Once the account is closing the banner is up, and this
  // keeps the date fresh as the day moves.
  window.setInterval(read, 60000);
})();
