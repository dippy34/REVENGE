# tools/

Scripts that run on the builder's machine. Nothing in here is deployed.

Planned for Phase 4 (see `docs/04-roadmap.md`):

- **leak check:** scan `site/` for external URLs (other than `youtube-nocookie.com`), the plain site name, personal strings, absolute local paths, and OS junk files such as `.DS_Store`.
- **metadata strip:** remove EXIF, author fields and editor metadata from assets, and set fixed file timestamps.
- **headless check:** load every route and confirm there are no cookies and no unexpected requests.
