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
- **Games, proxy, stats:** the same language (numbered HUD tiles, a terminal search and address bar, a terminal key prompt on stats).
- **404:** `site/404.html`, served by the server for any missing path and by static hosts.

## Anonymity feel
- Terminal-like typography (monospace), minimal chrome.
- Mask/ghost or abstract glyph motif, no photos, no faces.
- Short boot sequence on first load (skippable).
- Copy is terse and neutral. No usernames, no "welcome back".

## Menu
Three entries: `YouTube`, `Games`, `Proxy`. All three are live (Proxy needs the server in `server/`). Keyboard navigable.

## Quality bar
- Fast: no framework, small payload, no external fonts.
- Accessible: keyboard focus, readable contrast, reduced-motion support.
- Responsive from phone to desktop.
- Works with JS disabled at a basic level (menu links still navigate).
