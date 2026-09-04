"""Reject runtime data and obvious credentials before sharing this source tree.

Reports filenames only, never matching secrets. This is a targeted packaging
check, not a substitute for a complete security audit.
"""
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
patterns = [
    rb'sk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}',
    rb'(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}',
    rb'AKIA[0-9A-Z]{16}',
    rb'xox[baprs]-[A-Za-z0-9-]{20,}',
    rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
]
bad = []
count = total = 0
for rel in sorted(set(paths)):
    if not rel:
        continue
    path = root / rel
    parts = Path(rel).parts
    forbidden = any(part in ('data', 'node_modules', '.wrangler', '.venv', '.git') for part in parts)
    forbidden |= path.name == '.dev.vars' or (path.name.startswith('.env') and not path.name.endswith('.example'))
    forbidden |= path.suffix.lower() in ('.mov', '.mp4', '.sqlite', '.db', '.pem', '.key', '.p12')
    forbidden |= path.is_symlink()
    if forbidden:
        bad.append((rel, 'private/generated path'))
        continue
    if not path.is_file():
        continue
    data = path.read_bytes()
    count += 1
    total += len(data)
    if len(data) > 90 * 1024 * 1024:
        bad.append((rel, 'oversized file'))
    if any(re.search(pattern, data) for pattern in patterns):
        bad.append((rel, 'possible credential'))
if bad:
    for rel, reason in bad:
        print(reason + ': ' + rel)
    sys.exit(1)
print('Package check passed: %d files, %.1f MB. No forbidden runtime paths or obvious credentials.' % (count, total / 1024 / 1024))
