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
- Custom cursor and a soft spotlight that follows the pointer.
- Smooth page transitions between sections.
- Respect `prefers-reduced-motion`: effects calm down or turn off.

## Anonymity feel
- Terminal-like typography (monospace), minimal chrome.
- Mask/ghost or abstract glyph motif, no photos, no faces.
- Short boot sequence on first load (skippable).
- Copy is terse and neutral. No usernames, no "welcome back".

## Menu
Three entries: `YouTube`, `Games`, `Proxy`. Games is live. Proxy stays locked "soon". Keyboard navigable.

## Quality bar
- Fast: no framework, small payload, no external fonts.
- Accessible: keyboard focus, readable contrast, reduced-motion support.
- Responsive from phone to desktop.
- Works with JS disabled at a basic level (menu links still navigate).
