import { handleWaitlistRequest } from "./waitlist.js";
import { handleSendEmailRequest } from "./email-send.js";

// The path the meter, the billing webhook and the tests post a drive email to
// (src/email-send.js). One route, so one place knows the provider.
const SEND_EMAIL_PATH = "/api/emails/send";

// Static assets serve the pricing page; only /api/* reaches this Worker (see
// runWorkerFirst in cloudflare.config.ts). Anything that does reach it and is
// not the waitlist or send-email API falls through to the assets, so a stray
// path is a real 404 from the asset worker rather than a hand-rolled page.
//
// The send-email route is not mounted. Its only producers (the meter's cap
// emails and the billing webhook, build step 6 / drive#7) do not exist, and a
// route anyone can POST to is a way to mail an arbitrary person from our
// domain. Mounting it is one line, added with the first producer.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/waitlist" || url.pathname === "/api/waitlist/") {
      return handleWaitlistRequest(request, env.WAITLIST_DB);
    }
    if (url.pathname === SEND_EMAIL_PATH) {
      return handleSendEmailRequest(request, env.EMAIL);
    }
    return env.ASSETS.fetch(request);
  },
};
