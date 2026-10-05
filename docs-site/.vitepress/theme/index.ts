// The docs theme: the home page's design system, so the docs read as part
// of the site (issue #98, "same design system as the site"; drive#458).
//
// The palette and the type are copied from public/site.css rather than
// imported: VitePress cannot read a served asset, and the pricing page
// inlines much of its own layout. The tokens in this theme's site.css are
// the --drive-* values, and test/docs.test.mjs checks each one against the
// shared stylesheet, so the two cannot drift apart. The docs' own numbers
// come from src/billing.js through src/render-docs.js, never from here.

import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./site.css";

export default {
  extends: DefaultTheme,
} satisfies Theme;
