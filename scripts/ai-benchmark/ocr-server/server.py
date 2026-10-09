"""
Benchmark-only OCR service: RapidOCR (ONNX Runtime, CPU) behind a tiny HTTP API.

Not product code. It exists so run-benchmark.mjs can measure a classical OCR
engine the same way it measures Ollama: one request at a time, inside a
container capped like a VPS (--cpus 4 --memory 6g).

  POST /load  {"profile": "v5-mobile"}            -> builds the engine, returns load ms
  POST /ocr   {"profile": "...", "image": "<b64>"} -> lines with text, score and box
  GET  /health

Profiles (models baked into the image at build time, see Dockerfile):
  v5-mobile : PP-OCRv5 det mobile + latin_PP-OCRv5 rec mobile (Portuguese-capable)
  v5-server : PP-OCRv5 det server + ch_PP-OCRv5 rec server (ch dictionary covers
              Latin letters and digits; the "server_rec" variant)
  v6-small  : multi_PP-OCRv6 det small + rec small (RapidOCR 3.9.2 default)
Any profile accepts the suffix "+nocls" (no text-direction classifier).
"""

import base64
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR

THREADS = int(os.environ.get("OCR_THREADS", "4"))

PROFILES = {
    "v5-mobile": {
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Det.model_type": ModelType.MOBILE,
        "Det.lang_type": LangDet.CH,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
        "Rec.lang_type": LangRec.LATIN,
    },
    "v5-server": {
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Det.model_type": ModelType.SERVER,
        "Det.lang_type": LangDet.CH,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.SERVER,
        "Rec.lang_type": LangRec.CH,
    },
    "v6-small": {
        "Det.ocr_version": OCRVersion.PPOCRV6,
        "Det.model_type": ModelType.SMALL,
        "Det.lang_type": LangDet.CH,
        "Rec.ocr_version": OCRVersion.PPOCRV6,
        "Rec.model_type": ModelType.SMALL,
        "Rec.lang_type": LangRec.CH,
    },
}

ENGINES = {}


def build(profile):
    # "<profile>+nocls" skips the 180-degree text classifier: it flips
    # seven-segment LCD digits ("345.6" came back as "SShE").
    base, _, flag = profile.partition("+")
    params = dict(PROFILES[base])
    if flag == "nocls":
        params["Global.use_cls"] = False
    params.update(
        {
            "Global.log_level": "warning",
            "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }
    )
    return RapidOCR(params=params)


def engine(profile):
    if profile not in ENGINES:
        ENGINES[profile] = build(profile)
    return ENGINES[profile]


def read_lines(profile, image_b64):
    data = np.frombuffer(base64.b64decode(image_b64), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    started = time.perf_counter()
    out = engine(profile)(img)
    elapsed = (time.perf_counter() - started) * 1000
    lines = []
    if out.txts is not None:
        for box, text, score in zip(out.boxes.tolist(), out.txts, out.scores):
            lines.append({"text": text, "score": float(score), "box": box})
    return {"lines": lines, "inferMs": elapsed, "width": img.shape[1], "height": img.shape[0]}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # quiet
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "loaded": sorted(ENGINES)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        profile = body.get("profile", "v5-mobile")
        if profile.partition("+")[0] not in PROFILES:
            self._send(400, {"error": f"unknown profile {profile}"})
            return
        try:
            if self.path == "/load":
                ENGINES.pop(profile, None)
                started = time.perf_counter()
                engine(profile)
                self._send(200, {"loadMs": (time.perf_counter() - started) * 1000})
            elif self.path == "/ocr":
                self._send(200, read_lines(profile, body["image"]))
            else:
                self._send(404, {"error": "not found"})
        except Exception as error:  # surfaced to the runner as a transport error
            self._send(500, {"error": str(error)[:300]})


if __name__ == "__main__":
    if os.environ.get("OCR_PREFETCH"):
        for name in PROFILES:
            build(name)
        print("models fetched")
    else:
        # One request at a time, like OLLAMA_NUM_PARALLEL=1.
        ThreadingHTTPServer.daemon_threads = True
        server = ThreadingHTTPServer(("0.0.0.0", 8080), Handler)
        print("listening on 8080", flush=True)
        server.serve_forever()
