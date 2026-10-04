---
title: Pricing and your bill
description: The rate, the ceiling, the membership, downloads, and the bill worked out for four sizes.
---

# Pricing and your bill

## The rate

{{RATE}}, kept a month, counted by the minute. You pay for what you store, and
stop paying for what you delete.

## The ceiling

Your bill is the metered cost, cut off at a ceiling that rises with the size of
the drive: a flat {{CEILING_FLOOR}} until the drive passes 1.5 TB, then
{{CEILING_PER_TB}} for each TB after. A drive that grows never bills less.

The default cap is {{DEFAULT_CAP}}, so a drive up to 1.5 TB cannot be cut off
by default. Raise or lower it in your account, and at your cap the drive goes
read-only: nothing is deleted and the bill stops there.

## The membership

{{MEMBERSHIP}}
{{FOUNDING}}
We need a card at sign-up because there is no free tier.

## Downloads

Free up to {{FREE_DOWNLOAD_MULTIPLE}} times what you store, then
{{DOWNLOAD_RATE}}. Bringing files down is cheap; keeping them is what you pay
for.

## Version history

{{VERSION_HISTORY}} {{NOT_OPEN}} See [Limits](/limits) for what is not in
version 1.

## The bill worked out

Storage is counted for the part of the month you kept it, so a drive that grew
pays only for the days each file was there. The meter is the rate on that; the
ceiling is the largest the drive got; your bill is the membership or the
smaller of the meter and the ceiling, whichever is larger.

{{BILL_TABLE}}

The last column is the whole month. An empty drive still bills the membership.

## Savings calculator

The pricing page has a public savings calculator: enter how many TB you keep
all month, and it shows this month's bill beside our own flat-plan ceiling.
The numbers come from the same function the invoice uses (`monthBillCents` via
`GET /api/quote`). It does not name a rival or quote a rival's price. The
headline on that page stays the rate, 2¢ per GB.

## Honest notes

- There is no plan size. A drive is a drive: you are never moved to a bigger
  plan, and there is a cap you can set that stops spending before you think
  about it.
- We do not advertise a per-minute price. The rate is monthly; the minute is
  how the meter follows you when you delete something.
- Every figure above is worked out by the same function the invoice is worked
  out from, and a test fails the build if the page and the invoice disagree.
- What is not in version 1 is on the [Limits](/limits) page, and it is
  stated there rather than promised here.

## A bill that looks wrong, checked in order

A per-minute bill with a ceiling and a membership can look wrong three
different ways, and only the first one is the bill:

1. **The metered figure.** `drive status` shows this month's cost so far, and
   the usage page shows the month's stored size worked out from the same
   numbers as the invoice.
2. **The ceiling.** Your bill is the smaller of the metered cost and the
   ceiling, so a drive that grew pays for the days each file was there, never
   more than the ceiling below, and never less than the membership.
3. **The membership.** Storage use counts toward it. Go past it and you pay
   by the minute for the rest.

When those three agree with the invoice, [tell us](/faq) the month and the
figure; the docs do not promise a refund, so nobody will read one here.
