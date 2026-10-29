# 02 - Design

## Theme
Strictly **black and white** (plus grays). No accent colors. Contrast does the work.

## Name handling
The site is called "Revenge" internally, but it should not be obvious.
- The visible title is never the plain word. Options to choose from during the build:
  - Glyph/cipher form (for example leetspeak, reversed, or a substitution cipher shown as the logo).
  - A decode-on-hover effect: scrambled characters that resolve into the real word only briefly or only on interaction.
  - A hint instead of the word: an icon, a pattern, or the letter "R" treated as a mark.
- The page `<title>` and tab text use something neutral or scrambled, never the plain name.
- The domain and URL path are random and unrelated to the name.

## Effects (all CSS/canvas/JS, self-hosted, no libraries from CDNs)
- Matrix-style falling-glyph or noise background on the menu, low opacity.
- Glitch / text-scramble on headings and on hover.
- Film grain and subtle scanlines overlay.
- Custom cursor (dot + ring). The soft spotlight that followed the pointer was removed on 2026-10-19 at the owner's request.
- Smooth page transitions between sections.
- Respect `prefers-reduced-motion`: effects calm down or turn off.

### Since the visual overhaul (2026-10-19)
The whole site reads as one monochrome CRT / terminal HUD: square corners, corner brackets, phosphor glow, decode-in text, staggered reveals, terminal tags (`// section [12]`, `> play_`).
- **Rain:** three depth layers with glowing heads and mutating trails. Glyphs near the pointer swell (a lens, not a glow layer), and a click sends a shockwave.
- **Glyph object:** the hex mark as a rotating ASCII-shaded solid behind the menu title (a broken version on the 404).
- **Overlays:** finer scanlines, a soft flicker, an occasional interference line (menu and 404 only), and viewport corner brackets.
- **Cursor:** dot + trailing ring. On anything clickable, four corner brackets lock onto the control's box. Optional `data-cursor` label. Fine pointers only.
- **Transitions:** CRT power-off when leaving a page, power-on when the next one opens. Inside the YouTube app, views dim out and rise in.
- **Boot:** power-on line, hex dump, progress bars, then the digest decodes and flies into the menu title. First visit only, skippable.
- **YouTube:** gray glass top bar (thumbnails turn gray under it), generated identicon avatars, grayscale blurred ambient glow behind the player and Shorts, skeleton loaders, a terminal build log, library stat tiles and an ASCII chart of topic weights.
- **Music (cut down 2026-10-29):** the YouTube section's language for a music player. Gray glass top bar (`~/m/route_`), terminal tags on songs (`full`, `30s`), corner brackets that lock onto a cover on hover, a `+` on every song to add it to a playlist, `[now] [queue]` panel tabs and ASCII-mask empty states. Covers keep their colour; artists get generated hex identicons instead of photos. While a song loads, three dots pulse in the play button and a light runs along the progress line. The YouTube video stays hidden.
- **Chat:** full screen like the ghost. `[global]` and `[rooms]` in the bar, your icon, name and title on the right. Messages: your picture in a square (or your name's first letter), the name, a title (`owner` solid white and glowing, `admin` outlined, `guest` dashed), the time; a run from one person shares one head. The little guy (the hex with eyes, blinking) asks for your name, asks for private rooms' passwords (shaking his head at a wrong one, happy eyes when it's right) and delivers the owner's warnings.
- **Games, proxy, stats:** the same language (numbered HUD tiles, a terminal search and address bar, a terminal key prompt on stats).
- **404:** `site/404.html`, served by the server for any missing path and by static hosts.

## Anonymity feel
- Terminal-like typography (monospace), minimal chrome.
- Mask/ghost or abstract glyph motif, no photos, no faces.
- Short boot sequence on first load (skippable).
- Copy is terse and neutral. No usernames, no "welcome back".

## Menu
Four entries: `YouTube`, `Games`, `Proxy`, `Other`. Proxy, Movies and Music need the server in `server/`.
- `Movies` (under `Other`) opens one site through the proxy with no browser around it: the proxy's start screen (rain, `// movies`, a status line) stays up while the site loads and reloads once, then the site takes the whole window.
- `Other` (a `+` that turns on hover) swaps the list in place for a second one, `~/other`: the rows scramble, the white bar strikes each one and it tears off to the left, the rain bursts and the title glitches, then the new rows print in. It holds `music` (tagged `experimental` with a crawling hatch), `movies`, `chat` and `back`. Browser back closes it; `/#other` opens it.
- Keys: arrows or j/k, 1-n, → or l on `other` opens it, Esc / ← / h / Backspace goes back. Without JS, `#other` swaps the lists with CSS alone.
- The effects level sits beside the clock: a quiet `effects: max` tag, or below max a solid white `potato mode` tag that pulses a few times (and, once per visit when the site picked it, a note: "heads up: your device is running on potato mode"). Clicking it opens a menu: why, the four levels (`max`, `medium`, `low`, `extra low`) with a `recommended` tag on what the device measured as, and `auto`. A picked level is kept until `auto`. Extra low is only ever picked: the low tier with nothing moving at all (no rain, grain or scanlines).

## Quality bar
- Fast: no framework, small payload, no external fonts.
- Accessible: keyboard focus, readable contrast, reduced-motion support.
- Responsive from phone to desktop.
- Works with JS disabled at a basic level (menu links still navigate).
