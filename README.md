# UGC Beasts: complete creator system

The local video editor and web dashboard, together in one private repository.
This is an independent copy. It does not connect to the original owner's laptop,
database, Cloudflare account, API keys, videos or photo library.

## Quick start

Install Python 3.11 and Node.js 24, then clone this private repository or download
its ZIP while signed in to a GitHub account with access.

```sh
git clone https://github.com/loganjacobmurphy/ugcbeasts-system.git
cd ugcbeasts-system
python3 scripts/start.py --setup
```

On Windows, use `py -3 scripts/start.py --setup`. On later runs, leave off
`--setup`. On a Mac you can also run `./start.command` after the initial setup.

Open **http://127.0.0.1:8788**. The first setup creates a unique local login
passcode in `web/.dev.vars`, under `APP_PASSCODE`. Keep that file private.
Keep the terminal open while using the system. Ctrl+C stops this copy.

No Cloudflare account or paid API key is needed for local editing, dashboards,
campaigns or checklists. AI script writing and photo matching require your own
Anthropic API key, entered in the app. Model downloads need internet on first use.

## Included

- Raw video upload and resumable uploads, on-device transcription, pause/retake
  cutting, automatic scene splits, background removal and captions.
- Scene editor, backgrounds, overlays, personalized inbox generator, statistics
  cards, previews and 1080x1920 video export.
- The latest scene timing, numeric caption, stats layout, hook auto-fit and
  opening/closing screenshot placement fixes.
- Campaign dashboard, daily copy checklist, posting progress, library, formats,
  script generation, settings and optional multi-user access management.
- All backend/frontend source, API functions, database schema, generic format
  presets, bundled fallback fonts, startup scripts and regression tests.

## Not included

Private recordings, rendered videos, source photos, personal message screenshots,
campaign payment records, API keys, account tokens and licensed fonts are excluded.
Upload your own media into the Library before generating backgrounds. Preset
format names and collection names are included, but their image collections start
empty. No unrelated repository history is included.

## Layout

```text
editor/      FastAPI server, Python renderer and standalone editor
web/         React dashboard, Pages API functions and D1 schema
scripts/     Cross-platform local setup and startup
docs/        Full setup, assets and hosted deployment notes
```

For the full setup, optional hosting, asset tags and troubleshooting, see
[docs/SETUP.md](docs/SETUP.md). For dependency and asset notices, see
[THIRD_PARTY.md](THIRD_PARTY.md).

This is private source shared with authorized collaborators, not an open-source
license grant. Third-party software and assets retain their own licenses.
