// The docs theme: the pricing page's design system, so the docs read as part
// of the site (issue #98, "same design system as the site").
//
// The palette and the type are copied from public/index.html and
// public/usage.html rather than imported: the pricing page inlines its own
// stylesheet so it ships as one file with no extra request, and VitePress
// cannot read a `<style>` block out of another page. The tokens in site.css
// are the same values, and test/docs.test.mjs checks each one against the
// shipped pricing page, so the two cannot drift apart. The docs' own numbers
// come from src/billing.js through src/render-docs.js, never from here.
import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import "./site.css";

export default {
  extends: DefaultTheme,
} satisfies Theme;
