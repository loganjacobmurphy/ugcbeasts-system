#!/usr/bin/env python3
"""Bulk-import audience photos into the library, one folder per audience.

Drop the photos into ~/Downloads/regen-photos/<audience>/ and run this. The folder
name picks the collection, so nothing has to be tagged by hand afterwards and there
is no guessing about which picture belongs to which group.

    python3 import_photos.py                 # see what it would do
    python3 import_photos.py --go            # actually import

Folder names are matched loosely against the audience list: "PAWGs", "pawgs" and
"pawg" all land in the same place. Anything it cannot match is listed rather than
dumped somewhere wrong.
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import formats, store

SRC = os.path.expanduser("~/Downloads/regen-photos")
# how many a collection wants before it can carry a video on its own, see the note
# in the README block at the bottom of this file
TARGET = 20


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _index():
    """Every way he might name a folder -> the collection it means."""
    out = {}
    for a in formats.all_audiences():
        coll = a.get("collection")
        if not coll:
            continue
        for form in (coll, a.get("label"), a.get("word"), a.get("id", "")[2:]):
            key = _slug(form)
            if key:
                out.setdefault(key, coll)
            # "pawgs" typed as "pawg", "midgets" as "midget"
            if key.endswith("s"):
                out.setdefault(key[:-1], coll)
    return out


def _existing():
    counts = {}
    for a in store.load_library()["items"]:
        if a["type"] != "image" or a["folder"] in ("hinge", "extra", "app", "inserts"):
            continue
        if a.get("statsCard") or a.get("collage"):
            continue
        c = a.get("collection")
        if c:
            counts[c] = counts.get(c, 0) + 1
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--go", action="store_true", help="actually import (default is a dry run)")
    ap.add_argument("--src", default=SRC)
    args = ap.parse_args()

    if not os.path.isdir(args.src):
        print(f"nothing at {args.src}")
        print("make that folder, then a folder inside it per audience, e.g.")
        print("   regen-photos/pawgs/   regen-photos/goth mums/   regen-photos/wnba/")
        return 1

    index = _index()
    have = _existing()
    unknown, plan = [], []
    for name in sorted(os.listdir(args.src)):
        d = os.path.join(args.src, name)
        if not os.path.isdir(d) or name.startswith("."):
            continue
        coll = index.get(_slug(name))
        files = [f for f in sorted(os.listdir(d))
                 if store.asset_type(f) == "image" and not f.startswith(".")]
        if coll is None:
            unknown.append((name, len(files)))
            continue
        plan.append((coll, d, files))

    if unknown:
        print("NOT IMPORTED, folder name does not match an audience:")
        for name, n in unknown:
            print(f"   {name!r} ({n} images)")
        print()

    if not plan:
        print("nothing to import")
        return 0

    width = max(len(c) for c, _, _ in plan)
    total = 0
    for coll, d, files in plan:
        before = have.get(coll, 0)
        after = before + len(files)
        flag = "" if after >= TARGET else f"   still {TARGET - after} short"
        print(f"   {coll:<{width}}  +{len(files):<3} -> {after:<3}{flag}")
        total += len(files)
    print(f"\n{total} images across {len(plan)} audiences")

    if not args.go:
        print("\ndry run, nothing written. re-run with --go")
        return 0

    done = 0
    for coll, d, files in plan:
        for f in files:
            try:
                store.add_library_file("people", f, src_path=os.path.join(d, f),
                                       meta={"collection": coll})
                done += 1
            except Exception as e:
                print(f"   skipped {f}: {e}")
    print(f"\nimported {done} images")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
