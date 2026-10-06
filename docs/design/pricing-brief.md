# Pricing + landing page: design brief (step 9a)

Written for `Nishfleet/drive#11`. Follows the vault design workflow
(`_system/shared-memory/rules-library/design-workflow.md`): references, three
directions, build brief, then the audit and the live proof the issue demands.

**The business job.** Sell a Finder drive for people with libraries bigger than
their laptop, to someone who has never heard of us, on a page that must say what
it costs in the first viewport and ask for an email before they leave. It is not
a feature page. The whole first viewport is a price and a form.

## References (Mobbin, chosen for the business job, not beauty)

| # | Reference | What it teaches us here |
|---|---|---|
| 1 | [Cloudflare pricing](https://mobbin.com/screens/ed7a8366-15fd-4469-a1bc-169ef71a7730) | Infrastructure price expressed as one rate, with the unit stated next to it. The tone we need: an engineer's bill, not a subscription box. |
| 2 | [AWS S3 pricing](https://mobbin.com/screens/43392739-c713-4da9-a0ad-bb2bb99d2279) | Per-unit tables read as machinery. Useful as an anti-reference for warmth and for how a big price gets lost in a grid. |
| 3 | [Dropbox pricing](https://mobbin.com/screens/4ec3e534-0f82-48a3-8a08-54cafa099b03) | Plan columns with one clear lead plan. We invert this: one price, not a plan picker, because the whole pitch is that there is no plan size. |
| 4 | [Frame.io pricing](https://mobbin.com/screens/3dabe66e-b586-4751-a47a-46a627c66de6) | Storage-adjacent product speaking to video people, the exact buyer in the spec. Confirms the reader wants the number near the top, not in a tab. |
| 5 | [Proton pricing](https://mobbin.com/screens/9c1d7799-6ecc-4be8-a95d-616ff889acc4) | Privacy-leaning product that refuses the "credits" confusion. Same rule the spec gives us. |
| 6 | [Circle pricing](https://mobbin.com/screens/a3386e2a-1bd4-4b18-83e6-3a25b8145c42) | A "contact sales" column sitting beside self-serve tiers, which is exactly the Business "Talk to us" column. |
| 7 | [Kit waitlist](https://mobbin.com/screens/d69fb199-740d-4ad4-9629-8058b39bd6f5) | One email field, one button, no fuss. Our sign-up is a waitlist for now, so this is the shape. |
| 8 | [Mixpanel waitlist](https://mobbin.com/screens/5af7fde3-6700-4e26-9917-fa0ee083046b) | A waitlist that says what happens after you submit. Ours says the same, because silence is what kills waitlists. |

## Anti-references (what to avoid)

- **AWS per-unit price grids.** Correct for a table, wrong for a page whose only
  job is to be understood in four seconds. Everything that is not the headline
  price goes below the form.
- **The three-card "Basic / Pro / Team" grid with a purple-blue gradient hero.**
  The spec bans credit units and the word "unlimited"; a plan grid sells plans,
  and we sell a meter. A generic SaaS grid would also read true with a
  competitor's name swapped in, which the specificity gate fails.

## Three directions

### A — Safe: "the bill" (a receipt, not a landing page)

Cream paper, ink-black type, one accent. The hero is a literal billing
statement: the headline price set enormous on the left, the two spec lines
under it set as small print, the email field inlined beneath like a line on an
invoice. Worked examples as three ruled rows further down. Business as one column
in a two-column row.

Ingredients kept from: 1 (one rate with its unit), 6 (a talk-to-us column), 7
(one field, one button). Rejected: plan cards, per-unit tables, feature grids.
Fits because a billing statement is the most honest shape for a metered price,
and the reader is comparing us to a $15 plan they already have.

### B — Bold: "the terminal" (a live meter as the hero)

Near-black, phosphor green as the single accent, mono display face. The hero
is a terminal readout of what the drive costs right now: stored GB ticking into a
per-month line. The email form is the last line of the readout. Worked examples
are three commands with their output.

Ingredients kept from: 1 (an infrastructure rate), 5 (an anti-credits tone), 8
(after you submit, this is what happens). Rejected: the fake-terminal cliché of
a blinking cursor, anything that looks like a screenshot of a tool. Fits because
billed-by-the-minute is the product, and a meter makes that literal. The risk
is that a green terminal reads as a developer toy, and the spec's buyer is a
solo creator first, an agent second.

### C — Weird but plausible: "the shelf" (a 1 TB drawer in the first viewport)

Warm bone-white, one accent (a deep ink blue), a display face with real
character. The hero draws a 1 TB drawer of files as a horizontal strip of small
labelled file rectangles that occupy 60% of its width, with the leftover 40%
stamped in the accent and captioned "you pay for this part". The price sits
under the strip; the email field is the drawer label.

Ingredients kept from: 4 (a product that owns its visual world), 7 (one field,
one button). Rejected: skeuomorphic handles, drop shadows, anything that implies
a real cabinet. Fits because it makes "pay only for what you store" show rather
than say, and because a partly-full plan is exactly the situation the spec says
we win.

**Winner: A, with one graft from C** (the 60%-full strip, drawn flat and quiet,
sitting *below* the form rather than as the hero) and the mono face from B used
only for the numbers. A tasteful-but-quiet landing page does not land, so the
strip goes in to give the page one idea above the fold, and the price keeps the
ledger tone that the buyer's comparison actually needs.

## Build brief

1. **Section order.** Masthead (wordmark + one-line positioning) → price
   statement (the big number, the two spec lines, the $1 line) → the strip
   (60% full, one caption) → worked examples (three rows, exact spec copy) →
   the waitlist form (the only real action) → the two columns (What you get /
   What it costs) with the Business "Talk to us" column → footer.
2. **Above the fold composition.** A 3-line price statement occupying the left
   two thirds at 1440px, the form anchored bottom-left of the same block, and
   the strip running full width under it. Who it's for, what it does and a real
   next action are all above 900px tall.
3. **Typography rhythm.** Display face: a high-contrast serif for the number
   ("2¢" as one line, with "per GB, billed by the minute" set under it, not a
   fragment). Body: a neutral humanist sans. Numerals in the examples and the
   strip get the mono face, so the arithmetic is visibly arithmetic. Scale
   steps 1.25, body 17px, price `clamp(44px, 7.6vw, 92px)` (92px at 1440,
   44px at 360), the price is the only thing allowed to be large.
   (Issue #23's rework changed what the headline says: it was "about $20 per
   TB a month", which is the competitor's price, not ours. Rule 6 below bars unsourced
   claims and rival figures in our own voice, and that number was one. The
   The competitor figures in the worked-example rows are different: build-spec.md's
   "Bill ceiling" decision fixes them at $27 and $63, and they are labelled
   `(the competitor $…)` beside ours, cited there.)
4. **One accent.** Ink blue `#1f3a5f`, used for the filled 40%, the focus ring
   and the form's submit. No second accent anywhere.
5. **CTA hierarchy.** One filled button ("Join the waitlist"), one text link
   ("Business: talk to us"). Nothing else is clickable.
6. **Proof architecture.** Only sourced claims: the 2¢/GB rate, the $1 free
   month, the "500 GB for 3 days: about $1" example, and the free-version
   history. No competitor numbers on the page, no unsourced savings claims.
7. **Mobile behaviour.** One column below 720px. The price line wraps to three
   lines at 360px, the strip becomes a vertical bar, the form stacks. No
   element may exceed the viewport width at 360px; the price is the only thing
   allowed to be large, so it is the thing that gets the `clamp()`.
8. **Performance budget.** One HTML document, one CSS file, no framework, no
   web font files (system stacks only, so nothing blocks first paint). Total
   transfer under 40 KB. No client-side JavaScript except the form submit
   handler.

## Audit (design-polish pass) and live proof

Run against the deployed page, `https://drive-pricing.nishant345.workers.dev`,
with headless Chrome (Playwright, real network, `networkidle`).

| Check | Result |
|---|---|
| Desktop 1440x900 | 200, `scrollWidth == clientWidth == 1440`, no overflowing element, 0 console errors |
| Phone 390x844 | 200, `scrollWidth == clientWidth == 390`, 0 overflowing elements, 0 console errors |
| Small phone 360x780 | 200, `scrollWidth == clientWidth == 360`, 0 overflowing elements, 0 console errors |
| Contrast, WCAG AA normal text (>= 4.5) | body 15.13, free line 10.65, strip label 9.66, Talk to us 15.13, strip caption 7.29, eyebrow 4.99, field label 4.99, footer 7.29, form note 7.29 |
| Links | one link (`#waitlist`); no dead href, no external request, no favicon 404 |
| CTA | `Talk to us` tags the row `business`, scrolls the form into view and focuses `#email`; first Tab from the top reaches `#email` |
| External subresources | none. The stylesheet and the submit handler are inlined, so the page is one document: nothing to fetch, nothing to protect with SRI, and a data-URI favicon was dropped rather than kept behind a suppression |
| Timing | TTFB 76 ms, DOMContentLoaded 158 ms, load 158 ms (measured before inlining; inlining removed two round trips) |
| The real path | A browser at 390x844 typed an address and clicked the button; the live region read "You are on the list. One email when the drive is ready." with 0 console errors, and the row landed in D1 |

The eyebrow heading failed AA at 3.48:1 on the first pass (`--ink-faint: #8a8377`);
it is now `#6f6a5f` (4.99:1) and re-measured live.

**Re-measured after issue #23's rework** (rate headline, two figures per example
row). Headless Chrome on the built page at `file://public/index.html` (the
production URL updates on merge to main), viewport 1440x900 / 390x844 / 360x780,
device scale 2:

| Check | Result |
|---|---|
| Desktop 1440x900 | 200, `scrollWidth == clientWidth == 1440`, 0 overflowing elements, 0 console errors |
| Phone 390x844 | 200, `scrollWidth == clientWidth == 390`, 0 overflowing elements, 0 console errors |
| Small phone 360x780 | 200, `scrollWidth == clientWidth == 360`, 0 overflowing elements, 0 console errors |
| Headline reads as one line | "2¢ per GB, billed by the minute" |
| Example rows, as a reader sees them | 500 GB for 3 days: "about $1 → $0 after the free $1"; 800 GB: "$12 → $11 after the free $1"; 2 TB: "$16 → $15 after the free $1 (the competitor $27)"; 5 TB: "$40 → $39 after the free $1 (the competitor $63)" |
| Strip | "60% full · $11" |
| Contrast, WCAG AA normal text (>= 4.5) | headline 15.13, sub 15.13, free line 10.65, strip label 9.66, strip caption 7.29, example 15.13, the billed figure (bold) 15.13, the competitor comparison 4.99, examples note 7.29 |

The example rows overflowed 1440px on the first pass of the rework (`$16 → $15
after the free $1 (the competitor $27)` is one unbreakable run in a nowrap cell,
`scrollWidth 1476`); `white-space: normal` on the figure cell and a stacked row
under 520px fixed it, and the three viewports above are the re-measure.

Screenshots: `live-desktop.png`, `live-phone.png`, `live-phone-360.png`,
`live-phone-submitted.png` (the confirmed form state). The rate headline and the
$1 free in the worked examples are issue #23's rework, re-shot as
`live-desktop-ceiling.png` and `live-phone-ceiling.png`.

### Live waitlist rows (`drive-waitlist`, `93c9f523-159c-4261-8541-d4c059906df3`)

```
id  email                    source        created_at (UTC)
1   nish@0509.io             pricing-page  2026-09-29 17:15:22
3   founder@example.com      pricing-page  2026-09-29 17:16:55
5   team@acme.example        business      2026-09-29 17:18:37
6   phone-proof@example.com  pricing-page  2026-09-29 17:24:17
```

Rows 3, 5 and 6 are proof sign-ups typed into the live form (id 5 came through
the Business column, so `source` is `business`); ids 2 and 4 are the duplicate
attempts that correctly produced no second row.
