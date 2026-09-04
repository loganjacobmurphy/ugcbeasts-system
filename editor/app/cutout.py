"""Person cutout via MediaPipe selfie segmentation (IMAGE mode: stateless, random-access safe)."""
import os
import threading

import cv2
import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "selfie_segmenter.tflite")

_segmenter = None
_person_channel = None
_lock = threading.Lock()


def _get_segmenter():
    global _segmenter
    if _segmenter is None:
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        base = mp_python.BaseOptions(model_asset_path=os.path.abspath(MODEL_PATH))
        opts = vision.ImageSegmenterOptions(
            base_options=base,
            running_mode=vision.RunningMode.IMAGE,
            output_confidence_masks=True,
            output_category_mask=False,
        )
        _segmenter = vision.ImageSegmenter.create_from_options(opts)
    return _segmenter


def person_mask(rgb):
    """rgb uint8 HxWx3 -> float32 HxW in 0..1 (1 = person).

    The selfie model can expose one or two confidence channels depending on build;
    pick the channel that lights up in the frame center (where the subject is)
    once, then stick with it.
    """
    global _person_channel
    import mediapipe as mp
    with _lock:
        seg = _get_segmenter()
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        res = seg.segment(img)
        masks = [np.array(m.numpy_view()) for m in res.confidence_masks]
    if _person_channel is None:
        h, w = masks[0].shape[:2]
        cy, cx = slice(h // 3, h * 2 // 3), slice(w // 3, w * 2 // 3)
        centers = [float(m[cy, cx].mean()) for m in masks]
        _person_channel = int(np.argmax(centers))
    m = masks[_person_channel]
    if m.shape[:2] != rgb.shape[:2]:
        m = cv2.resize(m, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_LINEAR)
    return m


def person_alpha(rgb, lo=0.45, hi=0.85, blur=5):
    """uint8 alpha with soft edges."""
    m = person_mask(rgb)
    a = np.clip((m - lo) / (hi - lo), 0.0, 1.0)
    a = (a * 255).astype(np.uint8)
    if blur:
        a = cv2.GaussianBlur(a, (blur, blur), 0)
    return a


def person_rgba(rgb, **kw):
    a = person_alpha(rgb, **kw)
    out = np.dstack([rgb, a])
    return out
