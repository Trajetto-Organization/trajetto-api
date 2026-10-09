"""
trajetto-ai: the OCR service of the AI readings (ADR 0010, decision 14.1).

It only TRANSCRIBES: a photo in, text lines with score and box out. What the
lines mean (invoice number, receiving date, odometer) is decided by the API
in TypeScript (src/shared/ai/local/ocr-readings.ts), so business rules and
prompt injection never reach this container and a new engine never touches
a rule.

HTTP contract v1 (docs/desenho/ia-local-implementacao.md, P1):
  GET  /health                        200 after the warm-up, 503 before it
  POST /v1/read?profile=receipt|digits
       body: the image bytes (Content-Type image/jpeg|png|webp)
       header: Authorization: Bearer <AI_TOKEN>
       200 {"lines":[{"text","score","box"}],"width","height","inferMs",
            "queueMs","engine","engineVersion","profile"}
  Errors are {"error": "<code>"}, never an echo of the input:
       400 bad request / image / profile, 401 token, 413 bytes or pixels,
       503 busy (Retry-After), 500 engine failure.

No framework on purpose: one route, stdlib http.server, one read at a time.
"""

import hashlib
import hmac
import io
import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent

MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 25_000_000

# Before cv2 is imported anywhere: OpenCV's own ceiling, behind the header
# check below (a decompression bomb must not reach a full decode).
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(MAX_PIXELS))

ENGINE = "rapidocr"
ENGINE_VERSION = "3.9.2"

MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp"}

RETRY_AFTER_SECONDS = "5"


def profile_params():
    """The two measured profiles (results-2026-10.md). Do not change without a new benchmark."""
    from rapidocr import LangDet, LangRec, ModelType, OCRVersion

    return {
        # Receipt: PP-OCRv5 mobile, Latin recogniser (Portuguese accents and
        # handwritten dates), direction classifier on.
        "receipt": {
            "Det.ocr_version": OCRVersion.PPOCRV5,
            "Det.model_type": ModelType.MOBILE,
            "Det.lang_type": LangDet.CH,
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Rec.model_type": ModelType.MOBILE,
            "Rec.lang_type": LangRec.LATIN,
        },
        # Digits: PP-OCRv6 small, direction classifier OFF: it flips
        # seven-segment LCD digits ("345.6" came back as "SShE").
        "digits": {
            "Det.ocr_version": OCRVersion.PPOCRV6,
            "Det.model_type": ModelType.SMALL,
            "Det.lang_type": LangDet.CH,
            "Rec.ocr_version": OCRVersion.PPOCRV6,
            "Rec.model_type": ModelType.SMALL,
            "Rec.lang_type": LangRec.CH,
            "Global.use_cls": False,
        },
    }


PROFILES = ("receipt", "digits")


def build_engine(profile, threads):
    from rapidocr import RapidOCR

    params = dict(profile_params()[profile])
    params.update(
        {
            "Global.log_level": "warning",
            # The ONNX threads already saturate the cores this container
            # gets; inter-op parallelism would only add contention.
            "EngineConfig.onnxruntime.intra_op_num_threads": threads,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }
    )
    return RapidOCR(params=params)


def models_fingerprint():
    """Short hash of models.sha256: which weights this replica runs."""
    path = HERE / "models.sha256"
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    except OSError:
        return None


class Busy(Exception):
    pass


class Gate:
    """
    One inference at a time, a bounded wait in front of it.

    The ONNX threads take every core the container has: two reads in
    parallel are each slower than one after the other. A request beyond the
    queue, or one that waited past `wait_s`, is turned away with 503 so the
    API puts it back in its own queue (Postgres) instead of piling up here.
    """

    def __init__(self, max_queue, wait_s):
        self.max_queue = max_queue
        self.wait_s = wait_s
        self._cond = threading.Condition()
        self._running = False
        self._waiting = 0

    def acquire(self):
        """Seconds waited; raises Busy when full or after the wait."""
        started = time.monotonic()

        with self._cond:
            if self._running and self._waiting >= self.max_queue:
                raise Busy("queue_full")

            self._waiting += 1
            try:
                deadline = started + self.wait_s
                while self._running:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise Busy("queue_timeout")
                    self._cond.wait(remaining)
                self._running = True
            finally:
                self._waiting -= 1

        return time.monotonic() - started

    def release(self):
        with self._cond:
            self._running = False
            self._cond.notify()


def decode_image(data):
    """
    (BGR array, width, height). The size is read from the header first, so
    a 50 MP PNG of a few KB is refused before it is inflated in memory.
    Raises ValueError("invalid_image") or ValueError("too_many_pixels").
    """
    import cv2
    import numpy as np
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(data)) as header:
            width, height = header.size
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise ValueError("invalid_image")

    if width <= 0 or height <= 0:
        raise ValueError("invalid_image")

    if width * height > MAX_PIXELS:
        raise ValueError("too_many_pixels")

    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)

    if image is None:
        raise ValueError("invalid_image")

    return image, image.shape[1], image.shape[0]


def lines_of(output):
    """RapidOCR's output as JSON lines. Text never goes to the log."""
    lines = []
    texts = getattr(output, "txts", None)
    if texts is None:
        return lines

    for box, text, score in zip(output.boxes.tolist(), texts, output.scores):
        lines.append(
            {
                "text": str(text),
                "score": round(float(score), 4),
                "box": [[round(float(x), 1), round(float(y), 1)] for x, y in box],
            }
        )

    return lines


class OcrService:
    """State shared by every request thread: engines, gate, readiness."""

    def __init__(self, token, engines=None, max_queue=2, queue_wait_s=10.0, log=None):
        self.token = token.encode()
        self.engines = engines or {}
        self.gate = Gate(max_queue, queue_wait_s)
        self.ready = threading.Event()
        self.models_sha = models_fingerprint()
        self.log = log or (lambda record: print(json.dumps(record), flush=True))

    def warm_up(self, image_path=HERE / "warmup.jpg"):
        """Both profiles load and read once: /health is honest after this."""
        data = Path(image_path).read_bytes()
        image, _, _ = decode_image(data)
        for profile in PROFILES:
            self.engines[profile](image)
        self.ready.set()

    def authorized(self, header):
        expected = b"Bearer " + self.token
        given = (header or "").encode()
        # Constant time: the comparison must not leak the token's prefix.
        return hmac.compare_digest(given, expected)


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        # A client that stops sending mid-body must not hold a thread forever.
        timeout = 30
        server_version = "trajetto-ai"
        sys_version = ""

        def log_message(self, *args):
            pass

        def _send(self, status, payload, retry_after=False):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if retry_after:
                self.send_header("Retry-After", RETRY_AFTER_SECONDS)
            # One request per connection: a body left unread (413 by length)
            # never gets parsed as the next request.
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _drain(self, length):
            """Reads and discards `length` bytes, in chunks (no 8 MB buffer for a refusal)."""
            remaining = length
            try:
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        return
                    remaining -= len(chunk)
            except OSError:  # the handler's timeout: answer anyway
                return

        def _log(self, started, status, **fields):
            service.log(
                {
                    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "method": self.command,
                    "path": urlsplit(self.path).path,
                    "status": status,
                    "ms": round((time.monotonic() - started) * 1000, 1),
                    **fields,
                }
            )

        def do_GET(self):
            started = time.monotonic()
            if urlsplit(self.path).path != "/health":
                self._send(404, {"error": "not_found"})
                self._log(started, 404)
                return

            if not service.ready.is_set():
                self._send(503, {"ok": False, "error": "warming_up"})
                return

            self._send(
                200,
                {
                    "ok": True,
                    "engine": ENGINE,
                    "engineVersion": ENGINE_VERSION,
                    "profiles": list(PROFILES),
                    "modelsSha": service.models_sha,
                },
            )

        def do_POST(self):
            started = time.monotonic()
            url = urlsplit(self.path)

            if url.path != "/v1/read":
                self._send(404, {"error": "not_found"})
                self._log(started, 404)
                return

            try:
                declared = int(self.headers.get("Content-Length", ""))
            except ValueError:
                declared = None
            body = {"read": False}

            def refuse(status, code, retry_after=False, **fields):
                # A refusal sent over an unread body is lost: closing the
                # socket with bytes still incoming makes the kernel answer
                # with a TCP RST, and the client sees a reset instead of
                # 401/503 (busy counted as an outage). Above MAX_BYTES (413
                # by length) the body is not drained: nobody honest sends it.
                if not body["read"] and declared is not None and 0 < declared <= MAX_BYTES:
                    self._drain(declared)
                    body["read"] = True
                self._send(status, {"error": code}, retry_after=retry_after)
                self._log(started, status, error=code, **fields)

            if not service.authorized(self.headers.get("Authorization")):
                refuse(401, "unauthorized")
                return

            profile = (parse_qs(url.query).get("profile") or [""])[0]
            if profile not in PROFILES:
                refuse(400, "unknown_profile")
                return

            media_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if media_type not in MEDIA_TYPES:
                refuse(400, "unsupported_media_type", profile=profile)
                return

            if declared is None:
                refuse(400, "length_required", profile=profile)
                return

            length = declared
            if length <= 0:
                refuse(400, "empty_body", profile=profile)
                return

            if length > MAX_BYTES:
                refuse(413, "too_large", profile=profile, bytes=length)
                return

            # The body is read before the gate: a slow upload never holds the
            # one inference slot, and every refusal below is sent over a
            # fully read request.
            try:
                data = self.rfile.read(length)
            except OSError:
                data = b""
            body["read"] = True
            if len(data) != length:
                refuse(400, "truncated_body", profile=profile)
                return

            if not service.ready.is_set():
                refuse(503, "warming_up", retry_after=True, profile=profile)
                return

            try:
                waited = service.gate.acquire()
            except Busy as busy:
                refuse(503, "busy", retry_after=True, profile=profile, reason=str(busy))
                return

            try:
                try:
                    image, width, height = decode_image(data)
                except ValueError as invalid:
                    code = str(invalid)
                    refuse(413 if code == "too_many_pixels" else 400, code, profile=profile, bytes=length)
                    return

                infer_started = time.perf_counter()
                try:
                    output = service.engines[profile](image)
                    lines = lines_of(output)
                except Exception:  # the engine's message may quote the input
                    refuse(500, "engine_error", profile=profile, bytes=length)
                    return
                infer_ms = (time.perf_counter() - infer_started) * 1000
            finally:
                service.gate.release()

            self._send(
                200,
                {
                    "lines": lines,
                    "width": width,
                    "height": height,
                    "inferMs": round(infer_ms, 1),
                    "queueMs": round(waited * 1000, 1),
                    "engine": ENGINE,
                    "engineVersion": ENGINE_VERSION,
                    "profile": profile,
                },
            )
            self._log(
                started,
                200,
                profile=profile,
                bytes=length,
                lines=len(lines),
                inferMs=round(infer_ms, 1),
                queueMs=round(waited * 1000, 1),
            )

    return Handler


def serve(service, host="0.0.0.0", port=8080):
    ThreadingHTTPServer.daemon_threads = True
    server = ThreadingHTTPServer((host, port), make_handler(service))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def env_int(name, default, minimum, maximum):
    raw = os.environ.get(name, "")
    try:
        value = int(raw) if raw.strip() else default
    except ValueError:
        sys.exit(f"{name} deve ser um inteiro")
    if not minimum <= value <= maximum:
        sys.exit(f"{name} fora do intervalo {minimum}..{maximum}")
    return value


def main():
    token = os.environ.get("AI_TOKEN", "")
    # The same value as the API's AI_LOCAL_TOKEN. Required: an open OCR
    # endpoint on the stack network would read anyone's photos.
    if len(token) < 32:
        sys.exit("AI_TOKEN ausente ou curto (mínimo 32 caracteres; o mesmo valor de AI_LOCAL_TOKEN na API)")

    threads = env_int("OCR_THREADS", 2, 1, 32)
    max_queue = env_int("AI_MAX_QUEUE", 2, 0, 32)
    queue_wait_ms = env_int("AI_QUEUE_WAIT_MS", 10_000, 100, 60_000)
    port = env_int("PORT", 8080, 1, 65535)

    # PID 1 in the container: without a handler SIGTERM is ignored and every
    # stop waits for the SIGKILL. Nothing to drain: the API re-queues.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    engines = {profile: build_engine(profile, threads) for profile in PROFILES}
    service = OcrService(token, engines, max_queue=max_queue, queue_wait_s=queue_wait_ms / 1000)

    # Listening before the warm-up: the healthcheck sees 503 instead of a
    # refused connection, and a read that arrives early gets "warming_up".
    server = serve(service, port=port)
    started = time.monotonic()
    service.warm_up()
    print(
        json.dumps(
            {
                "event": "ready",
                "warmupMs": round((time.monotonic() - started) * 1000),
                "threads": threads,
                "maxQueue": max_queue,
                "modelsSha": service.models_sha,
            }
        ),
        flush=True,
    )

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
