import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const PUBLIC = new URL("../public/", import.meta.url);
const pages = readdirSync(PUBLIC).filter(
  (name) => name.endsWith(".html") && name !== "og-card.html",
);

test("every page links the touch icon and the manifest", () => {
  for (const name of pages) {
    const html = readFileSync(new URL(name, PUBLIC), "utf8");
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/, name);
    assert.match(html, /<link rel="manifest" href="\/site\.webmanifest">/, name);
  }
});

test("the manifest names real icons, with the sizes they have", () => {
  const manifest = JSON.parse(readFileSync(new URL("site.webmanifest", PUBLIC), "utf8"));
  assert.equal(manifest.short_name, "Storagebun");
  for (const icon of manifest.icons) {
    const file = new URL(icon.src.slice(1), PUBLIC);
    assert.ok(existsSync(file), `${icon.src} ships`);
    if (icon.type === "image/png") {
      const bytes = readFileSync(file);
      const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
      assert.equal(`${width}x${height}`, icon.sizes, `${icon.src} is ${icon.sizes}`);
    }
  }
  const touch = readFileSync(new URL("apple-touch-icon.png", PUBLIC));
  assert.equal(touch.readUInt32BE(16), 180);
  assert.equal(touch.readUInt32BE(20), 180);
});
