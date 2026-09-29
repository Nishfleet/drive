// Waitlist form submit. Without JavaScript the form still posts to
// /api/waitlist, so this only upgrades the response from a page reload to an
// inline confirmation. It must never fail silently: every path writes a line
// into the live region the markup already provides.
const form = document.getElementById("waitlist");
const note = document.getElementById("form-note");
const emailInput = document.getElementById("email");
const sourceInput = form.elements.namedItem("source");
const submit = form.querySelector("button[type=submit]");

function say(message, kind) {
  note.textContent = message;
  note.classList.toggle("is-error", kind === "error");
  note.classList.toggle("is-done", kind === "done");
}

// "Talk to us" is the same real action as the form, tagged so the waitlist row
// records which column the person came from.
for (const link of document.querySelectorAll("[data-waitlist-source]")) {
  link.addEventListener("click", () => {
    sourceInput.value = link.dataset.waitlistSource;
    emailInput.focus();
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  say("Joining the waitlist…", "pending");
  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: emailInput.value.trim(),
        source: sourceInput.value,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "That did not work. Try again in a moment.");
    }
    say(
      payload.already
        ? "You are already on the list. Nothing to do."
        : "You are on the list. One email when the drive is ready.",
      "done",
    );
    form.reset();
    sourceInput.value = payload.source;
  } catch (error) {
    say(error.message, "error");
  } finally {
    submit.disabled = false;
  }
});
