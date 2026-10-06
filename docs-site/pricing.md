---
title: Pricing and your bill
description: The rate, the maximum, downloads, and the bill worked out for four sizes.
---

# Pricing and your bill

{{HEADLINE}}

## The rate

{{SIZE_WINDOW}} {{RATE}} a month, never more than {{MAX_PER_TB}} for each TB. {{NO_PLANS}}

## Deleted files

{{TRASH_BILLING}} Deleting from the Files page moves the file to Recently
deleted, where it stays 30 days and you can restore it yourself.
[See how deletes and restores work](/how-it-works).

{{VERSION_MINIMUM}}

## The maximum

{{PRICE_RULE}} A drive that grows never bills less.

The default cap is {{DEFAULT_CAP}}. Raise or lower it in your account, and at
your cap the drive goes read-only: nothing is deleted and the bill stops there.

## Sign-up

We need a card at sign-up because there is no free tier.

## Downloads

Free up to {{FREE_DOWNLOAD_MULTIPLE}} times what you store, then
{{DOWNLOAD_RATE}}. Bringing files down is cheap; keeping them is what you pay
for.

## Version history

{{VERSION_HISTORY}} {{NOT_OPEN}} See [Limits](/limits) for what is not in
version 1.

## The bill worked out

You pay for the biggest size your drive reached in the last 30 days. The meter
is {{RATE}} on that size; the maximum is {{MAX_PER_TB}} for each TB of it, and
never less than one TB's worth; your bill is the smaller of the two.

{{BILL_TABLE}}

The last column is the whole month. An empty drive bills nothing.

## Savings calculator

The pricing page has a public savings calculator: enter how many TB you keep
all month, and it shows this month's bill beside our maximum and a usual 1 TB
plan. The numbers come from the same function the invoice uses
(`monthBillCents` via `GET /api/quote`).

## Honest notes

- There is no plan size. A drive is a drive: you are never moved to a bigger
  plan, and there is a cap you can set that stops spending before you think
  about it.
- Every figure above is worked out by the same function the invoice is worked
  out from, and a test fails the build if the page and the invoice disagree.
- What is not in version 1 is on the [Limits](/limits) page, and it is
  stated there rather than promised here.

## A bill that looks wrong, checked in order

A bill for the biggest size in 30 days, with a maximum, can look wrong two
different ways, and only the first one is the bill:

1. **The metered figure.** `drive status` shows the biggest size in the last
   30 days and today's draw, and the usage page shows those from the same
   function as the charge.
2. **The maximum.** Your bill is the smaller of the metered cost and the
   maximum, so a drive never pays more than {{MAX_PER_TB}} for each TB of
   that biggest size.

When those two agree with the invoice, [tell us](/faq) the month and the
figure; the docs do not promise a refund, so nobody will read one here.
