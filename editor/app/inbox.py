"""Personalize the approved Hinge inbox by changing only its avatar/name slots.

The reference screenshot is the UI, not a visual suggestion to redraw. Its status
bar, messages, icons, dividers and spacing are copied untouched into every output.
"""
import io
import os
import random

from PIL import Image, ImageDraw, ImageFont, ImageOps

from . import formats, store

# Set this to an asset id from your own Library after uploading a screenshot.
# The original user's private screenshot is deliberately not distributed.
TEMPLATE_ID = os.environ.get("GREENROOM_INBOX_TEMPLATE_ID", "")
TEMPLATE_SIZE = (1206, 2622)
VERSION = 1
NAME_BASELINES = (1089, 1371, 1653, 1935, 2217)
AVATAR_BOXES = tuple((60, 994 + 282 * i, 270, 1204 + 282 * i) for i in range(5))
# Row three's existing purple heart is outside the name slot and stays untouched.
NAME_BOXES = tuple((302, y - 63, 494 if i == 2 else 1000, y + 17)
                   for i, y in enumerate(NAME_BASELINES))
NAMES = {
    "indian mommys": ["Priya", "Anjali", "Meera", "Kavya", "Riya"],
    "snow bunnies": ["Aspen", "Sienna", "Sierra", "Chloe", "Brooke"],
    "asu sorority": ["Madison", "Kenzie", "Blair", "Taylor", "Peyton"],
    "goth mommys": ["Raven", "Lilith", "Salem", "Jade", "Willow"],
    "pawgs": ["Brooke", "Kaitlyn", "Kayla", "Amber", "Sierra"],
}
DEFAULT_NAMES = ["Sophie", "Lauren", "Ellie", "Grace", "Paige"]


def _font(size, regular=False):
    weight = "Regular" if regular else "SemiBold"
    path = os.path.join(os.path.dirname(__file__), "..", "fonts", "Inter-" + weight + ".ttf")
    return ImageFont.truetype(path, size)


def _portrait(path, size, crop=None, face=None):
    with Image.open(path) as src:
        img = ImageOps.exif_transpose(src).convert("RGB")
    if crop:
        x, y, side = crop
        side = max(1, min(float(side), img.width, img.height))
        x = min(max(0, float(x)), img.width - side)
        y = min(max(0, float(y)), img.height - side)
        img = img.crop((round(x), round(y), round(x + side), round(y + side)))
    elif face:
        cx, cy, fw = face[0] * img.width, face[1] * img.height, face[2] * img.width
        side = min(min(img.size), max(fw * 2.4, min(img.size) * 0.25))
        x = min(max(0, cx - side / 2), img.width - side)
        y = min(max(0, cy - side * 0.40), img.height - side)
        img = img.crop((round(x), round(y), round(x + side), round(y + side)))
    return ImageOps.fit(img, (size, size), Image.Resampling.LANCZOS, centering=(0.5, 0.28))


def render(template_path, profiles):
    """Return an exact-size screenshot with only the five requested slots changed.

    profiles contain a fictional display name, a source photo path, and optionally
    a reviewed square crop in source pixels (x, y, side) or cached face metadata.
    No messages or UI elements are generated or altered here.
    """
    if len(profiles) != 5:
        raise ValueError("The approved inbox template needs five profiles")
    with Image.open(template_path) as src:
        result = src.convert("RGB")
    if result.size != TEMPLATE_SIZE:
        raise ValueError("Inbox template dimensions changed; remeasure the slots first")
    draw = ImageDraw.Draw(result)
    for i, profile in enumerate(profiles):
        name = str(profile["name"]).strip()
        if not name:
            raise ValueError("Every inbox profile needs a name")
        avatar = _portrait(profile["path"], 210, profile.get("crop"), profile.get("face"))
        mask = Image.new("L", (210 * 4, 210 * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, 839, 839), fill=255)
        mask = mask.resize((210, 210), Image.Resampling.LANCZOS)
        x1, y1, x2, y2 = AVATAR_BOXES[i]
        # Clear the old edge too, so no pixels from the original profile leak out.
        backdrop = result.getpixel((x1 - 6, (y1 + y2) // 2))
        result.paste(backdrop, (x1, y1, x2, y2))
        result.paste(avatar, (x1, y1), mask)
        left, top, right, bottom = NAME_BOXES[i]
        backdrop = result.getpixel((1100, NAME_BASELINES[i]))
        draw.rectangle((left, top, right - 1, bottom - 1), fill=backdrop)
        size = 60 if i == 2 else 57
        font = _font(size, regular=i == 2)
        while draw.textlength(name, font=font) > right - 308 and size > 36:
            size -= 1
            font = _font(size, regular=i == 2)
        if draw.textlength(name, font=font) > right - 308:
            raise ValueError("Name is too long for the approved inbox slot")
        draw.text((306, NAME_BASELINES[i]), name, font=font, fill=(30, 32, 30), anchor="ls")
    return result


def create_asset(project, template, profiles=None, reviewed=False):
    """Create a project-owned inbox, using only photos from its library audience.

    The project stores the result id, so rebuilding cards never randomizes it or
    picks another video's inbox. Existing custom inbox selections are preserved.
    """
    reference = store.resolve_asset(template.get("id", ""))
    if not reference or not os.path.isfile(reference["path"]):
        return None
    audience = formats.audience(project.get("audience")) or {}
    collection = audience.get("collection") or ""
    if profiles is None:
        # Reuse reviewed face crops for this audience, never a different niche's
        # finished screenshot. This avoids falling back to a waist/ceiling crop.
        reviewed = [a for a in store.load_library()["items"]
                    if a.get("inboxTemplate") == template["id"]
                    and a.get("inboxAudience") == project.get("audience")
                    and a.get("inboxReviewed") and len(a.get("inboxProfiles") or []) == 5]
        for candidate in sorted(reviewed, key=lambda a: a.get("added", 0), reverse=True):
            saved = candidate["inboxProfiles"]
            if all(store.get_asset(p.get("asset")) for p in saved):
                profiles = saved
                break
    if profiles is None:
        pool = [a for a in store.load_library()["items"]
                if a.get("folder") == "people" and a.get("type") == "image"
                and a.get("collection") == collection and not a.get("collage")]
        random.Random(project.get("id", "")).shuffle(pool)
        pool.sort(key=lambda a: 0 if a.get("face") else 1)
        # Deduplicate exact image copies, which occur in the ASU library.
        import hashlib
        unique, seen = [], set()
        for asset in pool:
            path = store.resolve_asset(asset["id"])["path"]
            with open(path, "rb") as source:
                digest = hashlib.sha256(source.read()).hexdigest()
            if digest not in seen:
                unique.append(asset)
                seen.add(digest)
            if len(unique) == 5:
                break
        if len(unique) < 5:
            return None
        profiles = [{"name": name, "asset": a["id"], "face": a.get("face")}
                    for name, a in zip(NAMES.get(collection, DEFAULT_NAMES), unique)]
    resolved = []
    for profile in profiles:
        asset = store.get_asset(profile["asset"])
        if not asset or asset.get("collection") != collection or asset.get("folder") != "people":
            raise ValueError("Inbox photo is not in this video's audience library")
        source = store.resolve_asset(asset["id"])
        resolved.append({**profile, "path": source["path"]})
    image = render(reference["path"], resolved)
    content = io.BytesIO()
    image.save(content, format="PNG")
    return store.add_library_file(
        "app", "hinge_inbox_" + project["id"] + ".png", content=content.getvalue(),
        name="Hinge inbox, " + (audience.get("label") or collection),
        meta={"collection": "hinge inbox " + project["id"],
              "campaign": (project.get("campaign") or {}).get("id", ""),
              "inboxTemplate": template["id"], "inboxVersion": VERSION,
              "inboxProject": project["id"], "inboxAudience": project.get("audience"),
              "inboxProfiles": profiles, "inboxReviewed": bool(reviewed), "mockup": True})
