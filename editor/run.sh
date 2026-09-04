#!/bin/bash
# start greenroom at http://127.0.0.1:5710 (uses ./venv if you made one)
cd "$(dirname "$0")"
PY=python3
[ -x venv/bin/python ] && PY=venv/bin/python
exec "$PY" -m uvicorn app.server:app --host 127.0.0.1 --port 5710
