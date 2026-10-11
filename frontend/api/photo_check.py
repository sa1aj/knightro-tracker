"""Private CPU inference for the Supabase photo submission service."""
import hashlib
import hmac
import io
import json
import os
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

# Authenticate before importing ML libraries or fetching the private model.
MODEL_ID = "Endooou/knightro-checker-20261010-bd35ae7d"
MODEL_REVISION = "2e4b13d2ef456a987e20ea2da2b3c376dd993e65"
MODEL_HASH = "2a0860dc509679664759d71d7c16bfed5aad8c67057f0e7f41b416ec139c6d65"
THRESHOLD = 0.64576655626297
_session = None
_lock = threading.Lock()


def model_session():
    global _session
    with _lock:
        if _session is None:
            os.environ.setdefault("HF_HOME", "/tmp/knightro-hf")
            os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
            os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
            os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "5")
            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            token = os.environ.get("KNIGHTRO_HF_TOKEN")
            if not token:
                raise RuntimeError("Missing private model access")
            # Fixed, pinned repository; /tmp is the only runtime write location.
            path = hf_hub_download(MODEL_ID, "photo_checker.onnx", revision=MODEL_REVISION,
                                   token=token, cache_dir="/tmp/knightro-model", etag_timeout=4)
            if hashlib.sha256(Path(path).read_bytes()).hexdigest() != MODEL_HASH:
                raise RuntimeError("Model integrity check failed")
            options = ort.SessionOptions()
            options.intra_op_num_threads = 1
            options.inter_op_num_threads = 1
            _session = ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])
        return _session


def classify(raw):
    import numpy as np
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 800 * 800
    with Image.open(io.BytesIO(raw)) as source:
        if source.format != "JPEG" or max(source.size) > 800 or min(source.size) < 100:
            raise ValueError("Expected a normalized camera JPEG")
        image = source.convert("RGB").resize((224, 224), Image.Resampling.BILINEAR)
        pixels = np.asarray(image, dtype=np.float32) * np.float32(1 / 255)
    pixels = (pixels - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
    pixels = np.ascontiguousarray(pixels.transpose(2, 0, 1)[None])
    logits = model_session().run(None, {"pixel_values": pixels})[0][0]
    scores = np.exp(logits - logits.max())
    score = float(scores[1] / scores.sum())
    if not np.isfinite(score):
        raise RuntimeError("Invalid model output")
    return {"status": "detected" if score >= THRESHOLD else "review", "score": score,
            "threshold": THRESHOLD, "modelRevision": MODEL_REVISION, "modelHash": MODEL_HASH}


class handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log images, headers, or private request details.

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        expected = os.environ.get("KNIGHTRO_PROXY_TOKEN", "")
        provided = self.headers.get("X-Knightro-Proxy-Token", "")
        if not expected or not provided or not hmac.compare_digest(provided.encode(), expected.encode()):
            self.reply(403, {"error": "Unrecognized caller"})
            return False
        return True

    def do_GET(self):
        if self.authorized():
            self.reply(200, {"configured": bool(os.environ.get("KNIGHTRO_HF_TOKEN")),
                             "modelRevision": MODEL_REVISION, "mode": "review"})

    def do_POST(self):
        if not self.authorized():
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 300000 or self.headers.get("Content-Type") != "image/jpeg":
                self.reply(400, {"error": "Expected a normalized camera JPEG"})
                return
            raw = self.rfile.read(size)
            if len(raw) != size:
                raise ValueError("Incomplete image")
            self.reply(200, classify(raw))
        except ValueError:
            self.reply(400, {"error": "Unreadable normalized photo"})
        except Exception:
            # Supabase places this report in its private review queue on failure.
            self.reply(503, {"error": "Photo checker unavailable"})
