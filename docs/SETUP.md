# Setup and operation

## 1. Requirements

- Python 3.11 is the suggested install version. The code also has regression
  coverage on the original Python 3.9 environment; current third-party package
  availability can differ on older Python versions.
- Node.js 24 with npm. Node 22.18 or newer also meets the web runtime requirements.
- macOS with Apple Silicon is the original tested rendering platform. The startup
  script also supports Windows, but this release has not been tested on a Windows
  machine. NVIDIA/CPU device paths exist in the renderer; CPU matting is slower.
- Several GB for dependencies and model downloads, plus substantial free space for
  video sources, matte packs, previews and exports. These are kept on your machine.

## 2. Install and start the full local system

From the repository root:

```sh
python3 scripts/start.py --setup
```

Windows:

```powershell
py -3 scripts/start.py --setup
```

Setup creates `editor/.venv`, installs Python requirements, runs `npm ci`, initializes
the local D1 database from `web/schema.sql`, and builds the dashboard. It creates
`web/.dev.vars` only if that file does not exist. It never overwrites a saved key.

Two local services then run:

| Address | Purpose |
| --- | --- |
| http://127.0.0.1:8788 | Complete dashboard with API functions and local database |
| http://127.0.0.1:5710 | Standalone video editor |

The local dashboard asks for `APP_PASSCODE` from `web/.dev.vars`. That file is
ignored by Git. It is not the original owner's passcode or a shared preset password.
The local Cloudflare-compatible runtime does not deploy anything and does not need
a Cloudflare account. Cloud sync, if shown in the UI, points to your local D1 copy
in this mode, not to a remote workspace.

Subsequent starts:

```sh
python3 scripts/start.py
```

Or `./start.command` on Mac, `./start.ps1` on Windows. Stop with Ctrl+C.
The launcher never opens a browser automatically.

Install without starting: `python3 scripts/start.py --setup-only`.
Only start the editor: `python3 scripts/start.py --editor-only` after setup.
If ports are occupied, use `--editor-port 5721 --web-port 8793` and update
`GREENROOM_ORIGIN` in `web/.dev.vars` to match the editor port. It refuses to take
over an existing service.

## 3. Add your content

1. Create your own campaigns. Existing customer names, rates and account handles
   have deliberately not been seeded.
2. Open Content, Library and upload images you have permission to use.
3. Put audience photos in the `people` folder, with a collection matching the
   relevant audience in Formats. Use `/content/formats` to edit presets.
4. For CTA scenes, put the model original in an exact `og` collection, the swapped
   image in `result`, and the app screenshot in a collection named for the app,
   for example `regen`. Keep campaign ownership consistent.
5. Upload a recording. The first upload downloads speech/matting models. Later
   uploads reuse cached models. Inspect the transcript and stats before export.

The format presets carry automatic timing and placement rules, not a media
library. Missing photos must be supplied; the system does not invent assets or
reuse the original owner's files.

### Exact inbox template personalization

The personal inbox screenshot is not included. Upload your own approved template
into the `app` folder with collection `hinge inbox`. Set the environment variable
`GREENROOM_INBOX_TEMPLATE_ID` to its asset id before starting the editor.

The supplied exact-template slot recipe expects a **1206x2622** Hinge Matches
screenshot with the same five-row layout. Other dimensions are deliberately
rejected rather than edited in the wrong places. For a different layout, measure
and update `TEMPLATE_SIZE`, `AVATAR_BOXES`, `NAME_BOXES` and `NAME_BASELINES` in
`editor/app/inbox.py`, and run its pixel-preservation tests.

Generated profiles use fictional names and photos from your own matching audience
collection. Reviewed crops can be retained in each generated asset's recipe.
These are mockups, not proof of real conversations or results.

## 4. Optional AI features

Script writing and AI photo matching call Anthropic. Enter your own API key where
the app asks for it, or set `ANTHROPIC_API_KEY` in your private `web/.dev.vars`.
Calls can incur charges on that account. Never paste a key into source files.
Core transcription, editing, captions and rendering do not use that API.

## 5. Optional internet hosting

GitHub hosts this code, not the running video service. The full local setup above
is the simplest way for a friend to use it. For an internet-accessible dashboard:

1. Create your own Cloudflare Pages project and D1 database. Do not use another
   person's project, database identifiers, domain or tunnel credentials.
2. Create `web/wrangler.production.toml` from the local config with your real Pages
   name, database name and ID. This file is ignored by Git. Apply `schema.sql` to
   your own database.
3. Build `web/` with `npm ci` and `npm run build`.
4. Deploy from a separate staging directory containing `dist/`, `functions/`,
   package files and the production config named **wrangler.toml**. Pages deploy
   reads that filename. Do not accidentally deploy the zero-ID local config.
5. Set private Pages secrets. For a single-user install: `APP_PASSCODE`,
   `GREENROOM_ORIGIN` (your HTTPS tunnel address) and `GREENROOM_KEY`. The same
   `GREENROOM_KEY` must be set in the local editor's environment.
6. For multi-user hosting, configure your own Cloudflare Access application and
   Google login provider. Set `ACCESS_TEAM` and `ACCESS_AUD` on your Pages install.
   Protect the public hostname and keep the API's JWT verification enabled.
7. After your first verified login creates a pending `users` row, promote your
   own email through your D1 console:

   ```sql
   UPDATE users SET status='approved', is_admin=1 WHERE email='you@example.com';
   ```

   The People page can then approve collaborators. Each person registers their
   own editor origin and secret in Settings, so they do not share your GPU or data.

Keep the editor bound to loopback. Publish it only through an authenticated HTTPS
tunnel with a strong, unique shared key. Do not expose ports 5710/8788 or Vite's
development server directly to the internet. A hosted dashboard needs its editor
machine awake and its tunnel running for video editing to work.

## 6. Tests and development

```sh
cd editor
../editor/.venv/bin/python -m unittest discover -s tests
cd ../web
npm test
npm run build
```

On Windows use `.venv\Scripts\python.exe` from `editor/` for the Python tests.
`npm run dev` is a frontend-only development mode with a local editor proxy. It
does not run Pages API functions or D1. Use the root launcher for the full system.

## 7. Data and backups

- `editor/data/`: recordings, library, working files, formats, previews and renders.
- `web/.wrangler/state/`: the local dashboard database.
- `web/.dev.vars`: local credentials and optional API keys.
- Browser storage: cached campaign/checklist state and client-entered AI key.

Back up these private locations separately if wanted. They are never committed.
Deleting a project from the editor removes its local footage and working files.
Do not commit downloaded videos or your media library to work around GitHub file
size limits. Import your own material after installing instead.

## 8. Troubleshooting

- Content offline: leave the startup terminal open and confirm port 5710 is running.
- AI unavailable: provide your own Anthropic key and use the full local launcher.
- No backgrounds: upload/tag your own library photos; this repository starts empty.
- First upload slow: the models are downloading and the GPU is building the matte.
- Missing font: included fallbacks work; proprietary font files are not distributed.
- Windows error: capture the error and dependency versions. Mac is the verified
  platform; do not assume identical GPU/codec behavior without a test render.
