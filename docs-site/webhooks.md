---
title: Webhooks
description: Get a signed call on your own server when your balance changes, and how to check the signature.
---

# Webhooks

A webhook is a call Storagebun makes to a web address you own when something
happens on your account. Add one on the [Webhooks page](https://storagebun.com/webhooks)
after you sign in. Each endpoint has a **Send test** button and a log of the
last 20 deliveries.

## Events

| Event | When it is sent |
| --- | --- |
| `balance.topped_up` | A top-up was paid and added to your balance. |
| `balance.low` | Your balance fell to $2 or less. Sent once each time it falls that low, like the low-balance email. |
| `webhook.test` | You pressed **Send test**. |

Each call is a `POST` with a JSON body:

```json
{
  "id": "evt_1f3a...",
  "type": "balance.topped_up",
  "created": 1790000000,
  "data": { "payment_id": "pay_123", "amount_cents": 1500, "balance_cents": 1650 }
}
```

`balance.low` carries `balance_cents` and `auto_topup_cents` (null when auto
top-up is off).

## Check the signature

Every call carries three headers: `webhook-id`, `webhook-timestamp` and
`webhook-signature`. It is the [Standard Webhooks](https://www.standardwebhooks.com)
scheme, so a library for it works unchanged. The secret starts with `whsec_`
and is shown once, when you add the endpoint.

To check by hand, sign the text `<webhook-id>.<webhook-timestamp>.<raw body>`
with HMAC-SHA256, using the base64 part of the secret (after `whsec_`) as the
key, and compare the base64 result with the value after `v1,` in the header.
Also reject a timestamp more than five minutes old.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody) {
  const key = Buffer.from(secret.replace("whsec_", ""), "base64");
  const signed = `${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${rawBody}`;
  const expected = createHmac("sha256", key).update(signed).digest("base64");
  return headers["webhook-signature"].split(" ").some((part) => {
    const [, value = ""] = part.split(",");
    return value.length === expected.length &&
      timingSafeEqual(Buffer.from(value), Buffer.from(expected));
  });
}
```

## What to expect

- Answer with any `2xx` code within 4 seconds. We make one attempt per event and
  do not follow redirects. A failure is shown in the log; it never affects your
  payment.
- Use the `id` to ignore an event you have already handled.
- The address must be `https://` on a public host name. Up to 5 endpoints per account.
