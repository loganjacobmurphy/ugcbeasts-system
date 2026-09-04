#!/usr/bin/env python3
"""Cache a face box on every library photo, so avatars can be framed on the face.

Two detectors, and they are NOT equally trustworthy. The Haar cascade either finds a
real face or it does not. The silhouette fallback always returns something, which is
how a furry photo ended up cropped to a tree: it guesses the top of whatever it
thinks the person is, and when the segmentation is wrong the guess is wrong with it.
So a silhouette guess only counts if it looks like a head: up in the top of the
frame, and a sane fraction of the width. Anything else is left untagged and keeps the
old fixed crop, which is never brilliant but is never absurd either.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from app import store  # noqa: E402


def person_mask(rgb):
    """Where the person is, used to sanity check the cascade."""
    try:
        from app import cutout
        a = cutout.person_alpha(rgb)
        return a if a is not None and (a > 128).mean() > 0.02 else None
    except Exception:
        return None


def cascade_face(rgb, mask=None):
    import cv2
    c = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    faces = c.detectMultiScale(gray, 1.08, 6, minSize=(max(24, rgb.shape[1] // 20),) * 2)
    if not len(faces):
        return None
    H, W = rgb.shape[:2]
    x, y, w, h = max(faces, key=lambda f: f[2])
    cx, cy = x + w / 2, y + h / 2
    # The cascade is happy to find a face in foliage or in the markings on a paw, and
    # those false hits sit low in the frame and are small. A head in a portrait is
    # near the top and is a decent slice of the width. Same test the silhouette gets.
    if cy > H * 0.55 or w < W * 0.06:
        return None
    # ...and it has to actually be ON the person. A hit in the foliage behind a furry
    # passed every other test, because trees are as happy to look like a face as
    # anything else. The subject mask is the thing that tells them apart.
    if mask is not None:
        y0, y1 = max(0, int(cy - h * 0.3)), min(H, int(cy + h * 0.3))
        x0, x1 = max(0, int(cx - w * 0.3)), min(W, int(cx + w * 0.3))
        patch = mask[y0:y1, x0:x1]
        if patch.size and (patch > 128).mean() < 0.5:
            return None
    return (cx, cy, float(w))


def silhouette_head(rgb):
    from app import cutout
    a = cutout.person_alpha(rgb)
    ys, xs = np.where(a > 128)
    if len(ys) < 500:
        return None
    h, w = rgb.shape[:2]
    # a person filling almost nothing, or nearly everything, is a bad segmentation
    if not (0.05 < len(ys) / (h * w) < 0.92):
        return None
    top, bot = int(ys.min()), int(ys.max())
    band = ys < top + max(20, int((bot - top) * 0.16))
    bx = xs[band]
    if not len(bx):
        return None
    fw = float(np.percentile(bx, 90) - np.percentile(bx, 10))
    cx, cy = float(bx.mean()), float(top + (bot - top) * 0.10)
    # a head sits near the top and is a sensible slice of the frame
    if cy > h * 0.45 or not (w * 0.06 < fw < w * 0.65):
        return None
    return (cx, cy, max(60.0, fw))


def main():
    lib = store.load_library()
    todo = [a for a in lib["items"]
            if a["type"] == "image" and a["folder"] in ("people", "backgrounds")]
    print(f"{len(todo)} photos")
    n_face = n_body = n_none = 0
    for i, a in enumerate(todo, 1):
        path = os.path.join(store.LIBRARY, a["folder"], a["file"])
        box = src = None
        try:
            img = Image.open(path).convert("RGB")
            rgb = np.array(img)
            mask = person_mask(rgb)
            box = cascade_face(rgb, mask)
            src = "face" if box else None
            if not box:
                box = silhouette_head(rgb)
                src = "body" if box else None
        except Exception:
            box = None
        if box:
            cx, cy, fw = box
            a["face"] = [cx / img.width, cy / img.height, fw / img.width]
            a["faceFrom"] = src
            n_face += src == "face"
            n_body += src == "body"
        else:
            a["face"] = None
            a.pop("faceFrom", None)
            n_none += 1
        if i % 40 == 0:
            print(f"  {i}/{len(todo)}")
    store.save_library(lib)
    print(f"real face {n_face}, head estimate {n_body}, left on the old crop {n_none}")


if __name__ == "__main__":
    raise SystemExit(main())
