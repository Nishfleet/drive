# Design: public pages vs signed-in pages

Drive#458. The home page (drive#152) is the loud, price-first look: Big
Shoulders Display, Instrument Sans, JetBrains Mono, one orange accent on
warm paper. Every page a visitor can reach from that home page uses the
same tokens. How loud the page is depends on who it is for.

## Public pages (loud)

signin, starter, get-started, upload, docs, 404.

- The heading is the display face, heavy, often uppercase, like the home
  page's section titles.
- Buttons are ink pills.
- The wordmark carries the orange dash.
- No orange hero field. That field is the home page's job: it sells the
  price. These pages do a job (sign in, drop a file, read a doc).

## Signed-in pages (calmer)

files, usage.

- Same tokens, same wordmark, same body face.
- Headings still read `--serif`, which the alias points at the display
  face. They stay small, so the face is not a shout.
- Headings stay smaller. No uppercase display shout, no ticker, no orange
  field.
- The files page keeps its sticky bar, 44px taps and the folder path. The
  viewer title stays on the body face so a file name is not a poster.
- The usage page keeps its readouts and chart. The "you saved" line is
  body type, not the display face.

Calmer means the chrome matches the site and the work stays readable. It
does not mean a second palette.

## How a page opts in

`class="drive"` on `<html>` aliases the old `--paper` / `--serif` names
onto the `--drive-*` / `--font-*` tokens in `public/site.css`. Page CSS
does not restate the palette. The home page already reads `--drive-*`
directly and does not need the class.
