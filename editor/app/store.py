"""Disk persistence: projects, library, templates. Everything is JSON + files under data/."""
import json
import os
import re
import threading
import time
import uuid

from PIL import Image

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
PROJECTS = os.path.join(DATA, "projects")
LIBRARY = os.path.join(DATA, "library")
TEMPLATES = os.path.join(DATA, "templates", "templates.json")

FOLDERS = ["backgrounds", "hinge", "people", "app", "inserts", "extra"]
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm"}

_io_lock = threading.Lock()


def new_id(prefix):
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._") or "file"


# ---------------- projects ----------------
def project_dir(pid):
    return os.path.join(PROJECTS, pid)


def project_path(pid):
    return os.path.join(project_dir(pid), "project.json")


def _fill_defaults(p):
    """Projects created before newer features exist must never be missing fields:
    a missing key here froze the whole editor UI once."""
    p.setdefault("hook", {"text": "", "y": 0.45, "size": 85})
    p.setdefault("music", {"enabled": True, "file": "gymnopedie1.mp3", "volume": 0.07})
    p.setdefault("captions", {"enabled": True, "size": 84, "y": 0.80})
    p.setdefault("cutWords", [])
    p.setdefault("breaks", [])
    p.setdefault("scenes", [])
    p.setdefault("renders", [])
    p.setdefault("gapCut", 0.2)
    p.setdefault("app", "")
    p.setdefault("format", "")
    p.setdefault("audience", "")
    p.setdefault("campaign", {"id": "", "name": ""})
    p.setdefault("downloaded", False)
    p.setdefault("posted", False)
    return p


def load_project(pid):
    with _io_lock:
        with open(project_path(pid)) as f:
            return _fill_defaults(json.load(f))


def save_project(p):
    with _io_lock:
        tmp = project_path(p["id"]) + ".tmp"
        with open(tmp, "w") as f:
            json.dump(p, f)
        os.replace(tmp, project_path(p["id"]))


def list_projects():
    out = []
    if not os.path.isdir(PROJECTS):
        return out
    for pid in sorted(os.listdir(PROJECTS)):
        path = project_path(pid)
        if os.path.exists(path):
            try:
                p = _fill_defaults(json.load(open(path)))
                if not p.get("id") or not p.get("status"):
                    continue
                out.append({k: p.get(k) for k in
                            ("id", "name", "status", "progress", "error", "created",
                             "duration", "outDuration", "app", "format", "audience", "campaign",
                             # warning and appendError are the two things that can go
                             # wrong without failing the video, so both need showing
                             "downloaded", "posted", "warning", "appendError", "sortedBy")})
            except Exception:
                continue
    out.sort(key=lambda p: p.get("created") or 0, reverse=True)
    return out


def create_project(name):
    pid = new_id("p")
    os.makedirs(os.path.join(project_dir(pid), "thumbs"), exist_ok=True)
    os.makedirs(os.path.join(project_dir(pid), "renders"), exist_ok=True)
    p = {"id": pid, "name": name, "created": time.time(), "status": "uploading",
         "progress": 0.0, "error": None, "source": None, "words": [], "segments": [],
         "scenes": [], "breaks": [], "gapCut": 0.2,
         "captions": {"enabled": True, "size": 84, "y": 0.80},
         "hook": {"text": "", "y": 0.45, "size": 85},
         "music": {"enabled": True, "file": "gymnopedie1.mp3", "volume": 0.07},
         "app": "", "downloaded": False, "posted": False,
         "renders": []}
    save_project(p)
    return p


def delete_project(pid):
    import shutil
    d = project_dir(pid)
    if os.path.isdir(d):
        shutil.rmtree(d)


# ---------------- library ----------------
def _lib_manifest_path():
    return os.path.join(LIBRARY, "library.json")


def load_library():
    path = _lib_manifest_path()
    if not os.path.exists(path):
        return {"items": []}
    with _io_lock:
        return json.load(open(path))


def save_library(lib):
    with _io_lock:
        tmp = _lib_manifest_path() + ".tmp"
        json.dump(lib, open(tmp, "w"))
        os.replace(tmp, _lib_manifest_path())


def asset_type(filename):
    ext = os.path.splitext(filename)[1].lower()
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    return None


def make_thumb(src_path, thumb_path, kind):
    try:
        if kind == "image":
            img = Image.open(src_path).convert("RGB")
        else:
            import imageio.v2 as imageio
            rd = imageio.get_reader(src_path, "ffmpeg")
            img = Image.fromarray(rd.get_data(0))
            rd.close()
        img.thumbnail((280, 280))
        img.save(thumb_path, quality=85)
        return True
    except Exception:
        return False


def add_library_file(folder, filename, content=None, src_path=None, name=None, meta=None):
    """Add an asset from uploaded bytes or an existing file path. meta merges extra
    fields into the item (e.g. a dating card's generation recipe so it can be remade)."""
    if folder not in FOLDERS:
        folder = "misc"
    kind = asset_type(filename)
    if kind is None:
        raise ValueError(f"unsupported file type: {filename}")
    aid = new_id("a")
    fname = f"{aid}_{safe_name(filename)}"
    dest = os.path.join(LIBRARY, folder, fname)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if content is not None:
        with open(dest, "wb") as f:
            f.write(content)
    else:
        import shutil
        shutil.copy(src_path, dest)
    thumb_name = f"{aid}_thumb.jpg"
    thumb_path = os.path.join(LIBRARY, folder, thumb_name)
    has_thumb = make_thumb(dest, thumb_path, kind)
    item = {"id": aid, "name": name or os.path.splitext(filename)[0], "folder": folder,
            "file": fname, "thumb": thumb_name if has_thumb else None,
            "type": kind, "added": time.time()}
    item.update(meta or {})
    lib = load_library()
    lib["items"].append(item)
    save_library(lib)
    return item


def get_asset(aid):
    for item in load_library()["items"]:
        if item["id"] == aid:
            return item
    return None


def resolve_asset(aid):
    """For the renderer: id -> {path, type}."""
    item = get_asset(aid)
    if not item:
        return None
    return {"path": os.path.join(LIBRARY, item["folder"], item["file"]), "type": item["type"]}


def delete_asset(aid):
    lib = load_library()
    keep = []
    for item in lib["items"]:
        if item["id"] == aid:
            for f in (item["file"], item.get("thumb")):
                if f:
                    try:
                        os.remove(os.path.join(LIBRARY, item["folder"], f))
                    except OSError:
                        pass
        else:
            keep.append(item)
    lib["items"] = keep
    save_library(lib)
    _forget_asset(aid)


def _forget_asset(aid):
    """Clear an asset off every scene and template slot that still points at it.

    Without this a deleted photo leaves a dead id behind, which is not the same as
    an empty one: the pre-render check sees a filled background and the render
    quietly outputs the grey "no background yet" placeholder instead."""
    for meta in list_projects():
        try:
            p = load_project(meta["id"])
        except Exception:
            continue
        touched = False
        for sc in p.get("scenes") or ():
            for key in ("asset", "overlayAsset"):
                if sc.get(key) == aid:
                    sc[key] = None
                    touched = True
        if touched:
            p["rev"] = int(p.get("rev") or 0) + 1
            save_project(p)

    data = load_templates()
    touched = False
    for tpl in data.get("templates") or ():
        for slot in tpl.get("slots") or ():
            for key in ("asset", "overlayAsset"):
                if slot.get(key) == aid:
                    slot[key] = None
                    if key == "asset":
                        slot["sticky"] = False
                    touched = True
    if touched:
        save_templates(data)


# ---------------- templates ----------------
def load_templates():
    if not os.path.exists(TEMPLATES):
        return {"templates": []}
    with _io_lock:
        return json.load(open(TEMPLATES))


def save_templates(t):
    os.makedirs(os.path.dirname(TEMPLATES), exist_ok=True)
    with _io_lock:
        tmp = TEMPLATES + ".tmp"
        json.dump(t, open(tmp, "w"))
        os.replace(tmp, TEMPLATES)


def add_template(name, slots):
    t = load_templates()
    tpl = {"id": new_id("t"), "name": name, "slots": slots, "created": time.time()}
    t["templates"].append(tpl)
    save_templates(t)
    return tpl


def delete_template(tid):
    t = load_templates()
    t["templates"] = [x for x in t["templates"] if x["id"] != tid]
    save_templates(t)
