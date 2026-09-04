"""Install/start this independent copy. Both listeners bind only to loopback."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
EDITOR = ROOT / 'editor'
WEB = ROOT / 'web'
VENV = EDITOR / '.venv'
PYTHON = VENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
NPM = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')


def run(args, cwd):
    subprocess.run([str(a) for a in args], cwd=str(cwd), check=True)


def check_tools():
    if sys.version_info < (3, 9):
        raise SystemExit('Install Python 3.11, then run this again.')
    if not NPM or not shutil.which('node'):
        raise SystemExit('Install Node.js 24 (including npm), then run this again.')
    version = subprocess.check_output(['node', '--version'], text=True).strip()
    parts = tuple(int(part) for part in version.removeprefix('v').split('.')[:2])
    if parts < (22, 18):
        raise SystemExit('Node.js 22.18 or newer is required. This package was checked with Node 24.')


def free_port(port):
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit('Port %s is already in use. Stop your other copy or choose different ports.' % port)


def configure(editor_port):
    path = WEB / '.dev.vars'
    if not path.exists():
        text = 'APP_PASSCODE=' + json.dumps(secrets.token_urlsafe(18)) + '\n'
        text += 'GREENROOM_ORIGIN=' + json.dumps('http://127.0.0.1:' + str(editor_port)) + '\n'
        text += 'GREENROOM_KEY=""\n'
        # Exclusive creation and owner-only permissions. Never touches existing credentials.
        descriptor = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as out:
            out.write(text)
    else:
        expected = 'http://127.0.0.1:' + str(editor_port)
        if expected not in path.read_text():
            raise SystemExit('Set GREENROOM_ORIGIN in web/.dev.vars to ' + expected + ' before starting.')


def install():
    if not PYTHON.exists():
        venv.EnvBuilder(with_pip=True).create(str(VENV))
    run([PYTHON, '-m', 'pip', 'install', '-r', 'requirements.txt'], EDITOR)
    run([NPM, 'ci'], WEB)
    run([NPM, 'run', 'db:init'], WEB)
    run([NPM, 'run', 'build'], WEB)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--setup', action='store_true', help='Install dependencies and build before starting')
    parser.add_argument('--setup-only', action='store_true', help='Install and build without starting services')
    parser.add_argument('--editor-only', action='store_true', help='Only start the standalone editor')
    parser.add_argument('--editor-port', type=int, default=5710)
    parser.add_argument('--web-port', type=int, default=8788)
    args = parser.parse_args()
    check_tools()
    configure(args.editor_port)
    if args.setup or args.setup_only:
        install()
    if args.setup_only:
        return
    if not PYTHON.exists():
        raise SystemExit('First run: python3 scripts/start.py --setup')
    if not args.editor_only and not (WEB / 'dist/index.html').exists():
        raise SystemExit('First run: python3 scripts/start.py --setup')
    free_port(args.editor_port)
    if not args.editor_only:
        free_port(args.web_port)
    env = dict(os.environ)
    env['WRANGLER_SEND_METRICS'] = 'false'
    children = []
    try:
        children.append(subprocess.Popen([str(PYTHON), '-m', 'uvicorn', 'app.server:app',
                                         '--host', '127.0.0.1', '--port', str(args.editor_port)],
                                        cwd=str(EDITOR), env=env))
        ready = False
        for _ in range(100):
            if children[0].poll() is not None:
                raise SystemExit('Editor stopped during startup. Read the error above.')
            try:
                with urllib.request.urlopen('http://127.0.0.1:%s/api/state' % args.editor_port, timeout=1):
                    ready = True
                    break
            except OSError:
                time.sleep(0.2)
        if not ready:
            raise SystemExit('The editor did not become ready.')
        if not args.editor_only:
            wrangler = WEB / 'node_modules/wrangler/bin/wrangler.js'
            children.append(subprocess.Popen(['node', str(wrangler), 'pages', 'dev', 'dist',
                                             '--ip', '127.0.0.1', '--port', str(args.web_port)],
                                            cwd=str(WEB), env=env))
            print('\nOpen http://127.0.0.1:%s in your browser.' % args.web_port, flush=True)
            print('Your local login passcode is APP_PASSCODE in web/.dev.vars.', flush=True)
        else:
            print('\nOpen http://127.0.0.1:%s in your browser.' % args.editor_port, flush=True)
        print('Keep this terminal open. Ctrl+C stops this copy. No browser is opened automatically.', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.5)
        raise SystemExit('A service stopped. Read its error above.')
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == '__main__':
    main()
