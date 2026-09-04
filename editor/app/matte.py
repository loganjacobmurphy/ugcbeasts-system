"""Robust Video Matting pass: turn the normalized source into a 'matte pack' video,
foreground color on the left, alpha on the right, same height. Precomputed once per
project so the recurrent model keeps temporal consistency (no flicker) and renders
just decode it. Runs fp16 on the Apple GPU (~24 fps at 1080x1920 on this M2)."""
import subprocess
import threading

import numpy as np

from .media import StreamEncoder, ffmpeg_exe

_model = None
_device = None
_lock = threading.Lock()

VARIANT = "resnet50"  # heavier than mobilenetv3 but noticeably cleaner hair edges
DOWNSAMPLE = 0.375    # RVM guideline for 1080p-class portrait footage


def _load_hub():
    """Load RVM, preferring the copy already on this machine.

    torch.hub.load with a github repo still reaches out to GitHub even when the
    weights are cached, and a dropped connection there is not a reason to fall back
    to the pixely cutout. Two videos in one batch came out on the fallback because
    of exactly that, so the local checkout is tried first and the network is only a
    last resort."""
    import os
    import torch
    local = os.path.join(torch.hub.get_dir(), "PeterL1n_RobustVideoMatting_master")
    errs = []
    if os.path.isdir(local):
        try:
            return torch.hub.load(local, VARIANT, source="local")
        except Exception as e:      # a broken checkout should not be fatal either
            errs.append(f"local: {e}")
    for attempt in range(2):
        try:
            return torch.hub.load("PeterL1n/RobustVideoMatting", VARIANT, trust_repo=True)
        except Exception as e:
            errs.append(f"github try {attempt + 1}: {e}")
    raise RuntimeError("could not load the cutout model (" + "; ".join(errs) + ")")


def _get_model():
    global _model, _device
    if _model is None:
        import torch
        _device = ("mps" if torch.backends.mps.is_available()
                   else "cuda" if torch.cuda.is_available() else "cpu")
        m = _load_hub()
        m = m.to(_device).eval()
        if _device in ("mps", "cuda"):
            m = m.half()
        _model = m
    return _model, _device


class RawFrames:
    """Sequential rgb24 frames via an explicit ffmpeg pipe (decode honors the file's color tags)."""

    def __init__(self, path, w, h):
        self.w, self.h = w, h
        cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-i", path,
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=w * h * 3 * 4)

    def __iter__(self):
        n = self.w * self.h * 3
        while True:
            buf = self.proc.stdout.read(n)
            if buf is None or len(buf) < n:
                break
            yield np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3)
        self.proc.stdout.close()
        self.proc.wait()


def build_matte(normalized_path, out_path, w, h, fps, n_frames_est, progress=None, log_path=None,
                throttle=None):
    """Returns the number of frames matted. Raises if the model can't load (caller falls back)."""
    import torch
    with _lock:
        model, device = _get_model()
        dtype = torch.float16 if device in ("mps", "cuda") else torch.float32
        # near-lossless so h264 stops chewing the alpha fringe (the pack is the source of
        # truth for every render, any compression here shows up as edge crud). ultrafast
        # keeps the big 2x-wide frames from bottlenecking the matte pass; crf still governs
        # quality, so the file is a bit larger but the edges stay clean.
        enc = StreamEncoder(out_path, w * 2, h, fps, audio_wav=None,
                            log_path=log_path, preset="ultrafast", crf="6")
        rec = [None] * 4
        count = 0
        try:
            with torch.no_grad():
                for frame in RawFrames(normalized_path, w, h):
                    if throttle:
                        throttle()   # pauses while a render or preview owns the machine
                    src = torch.from_numpy(frame.copy()).permute(2, 0, 1).unsqueeze(0)
                    src = src.to(device, dtype).div_(255)
                    fgr, pha, *rec = model(src, *rec, DOWNSAMPLE)
                    # convert to uint8 on the GPU so the transfer back is small
                    fgr_np = fgr[0].mul(255).clamp_(0, 255).byte().permute(1, 2, 0).contiguous().cpu().numpy()
                    pha_np = pha[0, 0].mul(255).clamp_(0, 255).byte().cpu().numpy()
                    pack = np.concatenate([fgr_np, np.repeat(pha_np[..., None], 3, axis=2)], axis=1)
                    enc.write(pack.tobytes())
                    count += 1
                    if progress and count % 30 == 0:
                        progress(min(0.999, count / max(1, n_frames_est)))
        finally:
            rc = enc.finish()
        if rc != 0 or count == 0:
            raise RuntimeError(f"matte encode failed (ffmpeg {rc}, {count} frames)")
        return count


def split_pack(frame):
    """Matte pack frame -> RGBA person layer (straight alpha)."""
    w2 = frame.shape[1] // 2
    return np.dstack([frame[:, :w2], frame[:, w2:w2 * 2, 0]])
