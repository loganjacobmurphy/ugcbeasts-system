#!/usr/bin/env python3
"""Re-encode the cutout mattes at a sane bitrate.

They are written at CRF 6 "near lossless", which lands around 200 Mbps and makes one
40 second video cost a gigabyte. Measured against the original on a real matte, CRF 16
is 14.8x smaller for a mean alpha error of 0.18/255 (0.07%), with the worst pixels on
the hair edge where the mask is already a gradient. Nothing downstream can see that.

Each file is encoded to a temp, checked for the right frame count and decodability, and
only then swapped in. A failure leaves the original untouched.

    python3 compact_mattes.py            # report what it would save
    python3 compact_mattes.py --go
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import store  # noqa: E402
from app.media import ffmpeg_exe  # noqa: E402

FFMPEG = ffmpeg_exe()

CRF = "16"


def _count(path):
    r = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-map", "0:v:0",
                        "-f", "rawvideo", "-y", os.devnull, "-progress", "-", "-nostats"],
                       capture_output=True, text=True)
    n = 0
    for line in r.stdout.splitlines():
        if line.startswith("frame="):
            try:
                n = int(line.split("=", 1)[1])
            except ValueError:
                pass
    return n if r.returncode == 0 else None


def mattes():
    out = []
    for pid in sorted(os.listdir(store.PROJECTS)):
        p = os.path.join(store.PROJECTS, pid, "matte.mp4")
        if os.path.exists(p):
            out.append((pid, p, os.path.getsize(p)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--go", action="store_true")
    args = ap.parse_args()

    found = mattes()
    total = sum(s for _, _, s in found)
    print(f"{len(found)} mattes, {total / 1e9:.2f} GB")
    if not args.go:
        print(f"at CRF {CRF} expect roughly {total / 1e9 / 14.8:.2f} GB, saving ~{total / 1e9 * 13.8 / 14.8:.1f} GB")
        print("\ndry run. re-run with --go")
        return 0

    saved = 0
    for i, (pid, path, size) in enumerate(found, 1):
        tmp = path + ".compact.mp4"
        before = _count(path)
        if not before:
            print(f"[{i}/{len(found)}] {pid}: unreadable, left alone")
            continue
        r = subprocess.run([FFMPEG, "-y", "-v", "error", "-i", path,
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", CRF,
                            "-pix_fmt", "yuv420p", "-an", tmp], capture_output=True, text=True)
        ok = r.returncode == 0 and os.path.exists(tmp)
        after = _count(tmp) if ok else None
        # same number of frames, or the render would run short of matte and fall over
        if not ok or after != before:
            print(f"[{i}/{len(found)}] {pid}: FAILED ({before} -> {after}), original kept")
            if os.path.exists(tmp):
                os.remove(tmp)
            continue
        new = os.path.getsize(tmp)
        os.replace(tmp, path)
        saved += size - new
        print(f"[{i}/{len(found)}] {pid}: {size / 1e6:7.0f} -> {new / 1e6:6.0f} MB "
              f"({size / max(new, 1):4.1f}x, {before} frames)   running total {saved / 1e9:.1f} GB")
    print(f"\nfreed {saved / 1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
