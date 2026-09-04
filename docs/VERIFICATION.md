# Verification for this source snapshot

Checked on macOS with Python 3.9.6 and Node.js 24.14.0 before sharing:

- 65 Python regression tests passed in the independent editor copy.
- 15 Cloudflare Access signature/authentication checks passed.
- The React/TypeScript production build passed.
- A fresh local D1 database initialized successfully from schema.sql.
- The full local launcher started an isolated editor and dashboard on alternate
  ports without restarting or accessing the original editor.
- The dashboard served, unauthenticated API requests were rejected, authenticated
  API requests succeeded, and the authenticated editor proxy returned an empty
  project list.
- A script request without an API key was rejected without a paid API call.
- Source packaging excludes all original runtime data, production configuration,
  private screenshots, account photo and financial seed data.

Not tested here: clean Python dependency installation on another computer,
Windows rendering, a cold model download, or a deployment to a new Cloudflare
account. The provided setup supports these paths where documented, but they are
not represented as verified end-to-end tests.
