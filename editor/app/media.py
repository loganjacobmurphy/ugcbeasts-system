"""ffmpeg / audio helpers. Uses the ffmpeg binary bundled with imageio_ffmpeg (no system install needed)."""
import os
import re
import subprocess
import wave

import numpy as np
import imageio.v2 as imageio
import imageio_ffmpeg


def ffmpeg_exe():
    return imageio_ffmpeg.get_ffmpeg_exe()


_filters_cache = None


def has_filter(name):
    global _filters_cache
    if _filters_cache is None:
        out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-filters"],
                             capture_output=True, text=True).stdout
        _filters_cache = out
    return f" {name} " in _filters_cache


def color_info(path):
    """Inspect the source's color pipeline. HDR = bt2020 / PQ / HLG anywhere in the video stream line."""
    r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", path], capture_output=True, text=True)
    text = r.stderr
    vline = next((l for l in text.splitlines() if "Video:" in l), "")
    hdr = any(tok in vline for tok in ("bt2020", "smpte2084", "arib-std-b67"))
    return {"hdr": hdr, "stream": vline.strip()}


def target_fps_for(src_fps):
    """Preserve the smoothness Logan shot at. 60fps footage stays 60 (dropping to 30 is
    exactly what made it look choppy); oddball rates round to the nearest sane integer."""
    if src_fps > 45:
        return 60
    if src_fps > 20:
        return int(round(src_fps))
    return 30


def normalize_source(src, out, target_w=1080, target_fps=None):
    """One-time transcode every upload goes through: 1080-wide, constant frame rate matching
    the source (60 stays 60), SDR bt709 (tonemapped from HDR when needed), tagged. All
    downstream frames come from this file, so timing and colors stay consistent end to end."""
    info = color_info(src)
    if target_fps is None:
        target_fps = target_fps_for(probe(src)["fps"])
    chain = [f"fps={target_fps}", f"scale={target_w}:-2:flags=lanczos"]
    if info["hdr"] and has_filter("zscale") and has_filter("tonemap"):
        chain += ["zscale=transfer=linear:npl=100", "format=gbrpf32le",
                  "zscale=primaries=bt709", "tonemap=tonemap=hable:desat=0",
                  "zscale=transfer=bt709:matrix=bt709:range=tv"]
    chain += ["format=yuv420p"]
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
           "-i", src, "-vf", ",".join(chain), "-an",
           "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-g", str(target_fps),
           "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
           "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
           "-color_range", "tv", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True)
    return {"hdr": info["hdr"], "fps": target_fps}


def probe(path):
    """Return dict with fps, width, height, duration using a real decoded frame (handles rotation)."""
    reader = imageio.get_reader(path, "ffmpeg")
    meta = reader.get_meta_data()
    frame = reader.get_data(0)
    h, w = frame.shape[:2]
    duration = meta.get("duration")
    fps = meta.get("fps", 30.0)
    if not duration:
        nframes = meta.get("nframes")
        duration = (nframes / fps) if nframes and nframes != float("inf") else 0.0
    reader.close()
    return {"fps": float(fps), "width": int(w), "height": int(h), "duration": float(duration)}


def extract_audio(src, out_wav, rate=48000):
    """Mono 16-bit wav for both whisper and the final mix."""
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
           "-i", src, "-vn", "-ac", "1", "-ar", str(rate), "-c:a", "pcm_s16le", out_wav]
    subprocess.run(cmd, check=True)
    return out_wav


def read_wav(path):
    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return rate, data


def write_wav(path, rate, data):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data.astype(np.int16).tobytes())


def concat_speech(src_wav, segments, out_wav, fade_ms=8):
    """Cut [S,E] spans out of the wav and join them.

    Two rules, both of which matter more than they sound:

    A join where the source is already continuous (a long segment split in two) is
    left completely untouched. It used to get faded down to digital silence and back
    like every other join, which punched an audible hole into the middle of a word.

    A real cut is crossfaded using the removed audio as the handle, so the outgoing
    tail ends on the sample immediately before the incoming one begins. That is
    sample continuous across the splice: no step to click on, and the total length
    does not move by a sample."""
    rate, data = read_wav(src_wav)
    fade = max(1, int(rate * fade_ms / 1000))
    ramp_in = np.linspace(0.0, 1.0, fade)
    ramp_out = np.linspace(1.0, 0.0, fade)

    spans = []
    for (S, E, *_rest) in segments:
        a, b = int(S * rate), min(int(E * rate), len(data))
        if b - a >= fade * 2:
            spans.append((a, b))

    parts = []
    for k, (a, b) in enumerate(spans):
        piece = data[a:b].astype(np.float32)
        if k == 0:
            piece[:fade] *= ramp_in            # ease in from silence at the very top
        if k + 1 == len(spans):
            piece[-fade:] *= ramp_out          # and out at the very end
        elif spans[k + 1][0] != b:             # a real cut, so crossfade over the gap
            nxt = spans[k + 1][0]
            piece[-fade:] = (piece[-fade:] * ramp_out
                             + data[nxt - fade:nxt].astype(np.float32) * ramp_in)
        parts.append(piece)
    joined = np.concatenate(parts) if parts else np.zeros(rate, np.float32)
    write_wav(out_wav, rate, joined)
    return out_wav


def wav_duration(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / w.getframerate()


def concat_videos(parts, out):
    """Join same-pipeline mp4s losslessly with the concat demuxer (out may be parts[0]:
    the result lands in a temp file first). Verifies the joined duration."""
    lst = out + ".parts.txt"
    with open(lst, "w") as f:
        for pth in parts:
            f.write(f"file '{os.path.abspath(pth)}'\n")
    tmp = out + ".tmp.mp4"
    cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
           "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy",
           "-movflags", "+faststart", tmp]
    subprocess.run(cmd, check=True)
    total = sum(probe(x)["duration"] for x in parts)
    got = probe(tmp)["duration"]
    os.remove(lst)
    if abs(got - total) > 0.5:
        os.remove(tmp)
        raise RuntimeError(f"concat came out {got:.2f}s, expected {total:.2f}s")
    os.replace(tmp, out)
    return got


def append_wav(base_wav, extra_wav, out_wav, base_target_dur):
    """Grow the voice wav by a new clip's audio. The base is padded or trimmed to
    exactly the base video duration so the audio join lines up with the video join."""
    rate, a = read_wav(base_wav)
    rate_b, b = read_wav(extra_wav)
    if rate_b != rate:
        raise RuntimeError(f"sample rate mismatch {rate} vs {rate_b}")
    n = int(round(base_target_dur * rate))
    if len(a) < n:
        a = np.concatenate([a, np.zeros(n - len(a), dtype=np.int16)])
    else:
        a = a[:n]
    write_wav(out_wav, rate, np.concatenate([a, b]))
    return out_wav


def grab_frame(path, t):
    """Fast single-frame grab at time t (keyframe seek, auto-rotated). Returns RGB numpy array."""
    import io
    from PIL import Image
    cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error",
           "-ss", f"{max(0.0, t):.3f}", "-i", path,
           "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
    out = subprocess.run(cmd, capture_output=True, check=True).stdout
    img = Image.open(io.BytesIO(out)).convert("RGB")
    return np.array(img)


class SourceFrames:
    """Sequential-friendly frame access over a video. Seeking backwards reopens the reader."""

    def __init__(self, path):
        self.path = path
        self._open()

    def _open(self):
        self.reader = imageio.get_reader(self.path, "ffmpeg")
        self.fps = float(self.reader.get_meta_data()["fps"])
        self.it = self.reader.iter_data()
        self.idx = -1
        self.frame = None

    def at_time(self, t):
        return self.at_index(int(round(t * self.fps)))

    def at_index(self, idx):
        if idx < self.idx:
            self.reader.close()
            self._open()
        while self.idx < idx:
            try:
                self.frame = next(self.it)
                self.idx += 1
            except StopIteration:
                break
        return self.frame

    def close(self):
        try:
            self.reader.close()
        except Exception:
            pass


# Short form delivery target. Everything he has shipped so far sits around -25 LUFS
# with an 8 LU spread between videos, so each one lands at a different volume and all
# of them are quiet next to anything else in the feed.
TARGET_LUFS = -14.5
TRUE_PEAK_CEILING = 0.891      # about -1 dBTP, as a linear limiter threshold


def measure_lufs(wav_path):
    """Integrated loudness of a wav, or None if it cannot be measured. One cheap pass
    (about 0.15s on a 45s file) so the gain can be applied as a plain static volume
    rather than trusting a single pass loudnorm to guess."""
    try:
        out = subprocess.run(
            [ffmpeg_exe(), "-hide_banner", "-nostats", "-i", wav_path,
             "-filter_complex", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True, timeout=120).stderr
        m = re.findall(r"I:\s*(-?\d+(?:\.\d+)?)\s*LUFS", out)
        return float(m[-1]) if m else None
    except Exception:
        return None


class StreamEncoder:
    """Pipe raw RGB frames into ffmpeg -> faststart h264 mp4, correctly converted and tagged
    as bt709 tv-range so players show the same colors we composited. Audio wav optional;
    music_path mixes a looped quiet bed under the voice with a fade at the end."""

    def __init__(self, out_path, w, h, fps, audio_wav=None, log_path=None, preset="medium", crf="18",
                 music_path=None, music_volume=0.08, duration=None):
        to709 = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"
        cmd = [ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "warning",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-"]
        if audio_wav:
            cmd += ["-i", audio_wav]
        # bring the voice to the delivery target before anything is mixed under it, so
        # the bed sits at a fixed distance below his voice however loudly he spoke
        gain = ""
        if audio_wav:
            measured = measure_lufs(audio_wav)
            if measured is not None and measured > -70:
                gain = f",volume={TARGET_LUFS - measured:.2f}dB"
        limit = f"alimiter=limit={TRUE_PEAK_CEILING}:level=disabled"
        if audio_wav and music_path:
            cmd += ["-stream_loop", "-1", "-i", music_path]
            fade = f",afade=t=out:st={max(0.0, (duration or 0) - 2.0):.2f}:d=2" if duration else ""
            flt = (f"[0:v]{to709}[v];"
                   f"[1:a]aformat=channel_layouts=stereo{gain}[s];"
                   f"[2:a]volume={music_volume}{fade}[m];"
                   f"[s][m]amix=inputs=2:duration=first:normalize=0,{limit}[a]")
            cmd += ["-filter_complex", flt, "-map", "[v]", "-map", "[a]",
                    "-c:a", "aac", "-b:a", "160k"]
        elif audio_wav:
            flt = f"[0:v]{to709}[v];[1:a]aformat=channel_layouts=stereo{gain},{limit}[a]"
            cmd += ["-filter_complex", flt, "-map", "[v]", "-map", "[a]",
                    "-c:a", "aac", "-b:a", "160k"]
        else:
            cmd += ["-filter_complex", f"[0:v]{to709}[v]", "-map", "[v]"]
        cmd += ["-c:v", "libx264", "-preset", preset, "-crf", crf,
                "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709",
                "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                "-color_range", "tv",
                "-movflags", "+faststart", "-shortest", out_path]
        log = open(log_path, "wb") if log_path else subprocess.DEVNULL
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT)

    def write(self, rgb_bytes):
        self.proc.stdin.write(rgb_bytes)

    def finish(self):
        self.proc.stdin.close()
        return self.proc.wait()
