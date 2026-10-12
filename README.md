# Flo, the Chronicler

A desktop app that records step-by-step guides as you work — capturing clicks, screenshots, and element context automatically. Export to PDF, Word, or Confluence.

## Features

- **Web recording** — records clicks inside a browser tab loaded in the app
- **App recording** — records clicks inside any desktop application window
- **Screen recording** — records activity across an entire display
- Automatic screenshots on every captured action
- Element-aware step text (button names, menu items, form fields) via UIA / MSAA
- Export to PDF, Word, and Atlassian Confluence

## Download

Grab the latest installer from [Releases](../../releases).

## Development

```bash
cd app
npm install
npm start
```

Requires Node.js 18+ and Windows 10 v2004+ (for DPI-aware window capture).

## Build installer

```bash
cd app
npm run electron:pack        # patch version bump + NSIS installer
npm run electron:pack:minor  # minor version bump
npm run electron:pack:major  # major version bump
```

Output goes to `app/release/`.

## Repo layout

```
app/      Electron desktop application
server/   Shared guide storage and CI integration (in progress)
```
