// The site Worker's entry is split across src/index.js and its siblings
// (drive#617). A test that reads the entry's source to check a rule across the
// whole Worker reads them together here, so a rule is checked wherever the
// code now lives.
import { readFileSync } from "node:fs";

const INDEX_FILES = ["index.js", "index-app.js", "index-support.js", "index-scheduled.js"];

/** The text of the site Worker's entry and the modules split out of it. */
export function readIndexSource() {
  return INDEX_FILES.map((name) =>
    readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8"),
  ).join("\n");
}
