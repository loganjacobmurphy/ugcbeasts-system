# UGC Beasts system

This is a standalone distribution, not the original production checkout.

- `editor/` is the Python/FastAPI video editor. `web/` is the React dashboard and Cloudflare Pages API.
- Read `README.md` and `docs/SETUP.md` before changing setup or deployment.
- Do not copy credentials, user libraries, projects, personal screenshots or production database IDs into Git.
- Local startup uses `python3 scripts/start.py`. Do not change another running editor or reuse its data directory.
- Run the editor tests and `npm test` plus `npm run build` in `web/` before sharing changes.
- Never expose a Vite development server publicly. Hosted installs require their own Cloudflare Access configuration or a strong passcode and HTTPS tunnel key.
- Preserve manually edited scene images and timing. Number cards must match the recording.
- Keep the opening inbox and closing conversation in their intended order. User screenshots are supplied locally, not included in this repository.
