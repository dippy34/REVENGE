# 01 - Vision

## One line
A small, private hub with a video viewer and (later) a proxy, wrapped in a black-and-white, anonymous-feeling interface.

## Audience
People who get the link by word of mouth. No marketing, no search presence, no accounts.

## Sections

### 1. YouTube (built first)
- Works like normal YouTube: a home feed, Shorts, search, channels, subscriptions, likes, history.
- First visit asks you to build your feed from things you like. The feed then learns from what you watch, skip, like and subscribe to.
- Plays through the **privacy-enhanced embed** (`youtube-nocookie.com`). Pasting a link still plays any video.
- No API keys. Search data comes from nova-hub's public API (see `05-decisions.md`). The only backend is the proxy server in `server/` (see `06-backend.md`).
- Your profile, likes, subscriptions and history live only in your own browser (`localStorage`). One button forgets them.

### 2. Proxy (built last)
- Deferred until YouTube is done and polished.
- Scope is **not decided yet**. See open questions in `05-decisions.md`.
- Anything built here must follow the same no-logging, no-tracking rules.

## Build order
Menu + theme first, then YouTube, then Proxy.

## Out of scope
- User accounts, comments, chat, or anything that stores data about people.
- Analytics of any kind.
- Anything aimed at a specific person or group.
