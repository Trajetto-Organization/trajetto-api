"""
The trajetto-ai service contract (docs/desenho/ia-local-implementacao.md, P1).

Runs in the image's `test` build stage (CI) against a real HTTP server on an
ephemeral port. The engine is the real RapidOCR where the contract is about
reading (warm-up, the warm-up receipt's number) and a stand-in where it is
about the queue, so "busy" is provable without racing a 1 s inference.
"""

import io
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import server  # noqa: E402

TOKEN = "t" * 40
WARMUP = (HERE.parent / "warmup.jpg").read_bytes()


class FakeOutput:
    def __init__(self, lines):
        import numpy as np

        self.boxes = np.array([box for _, _, box in lines], dtype=float) if lines else np.zeros((0, 4, 2))
        self.txts = tuple(text for text, _, _ in lines) if lines else None
        self.scores = tuple(score for _, score, _ in lines)


class FakeEngine:
    """Answers one fixed line; `hold` blocks the read until released."""

    def __init__(self, hold=None):
        self.hold = hold
        self.calls = 0
        self.entered = threading.Event()

    def __call__(self, image):
        self.calls += 1
        self.entered.set()
        if self.hold is not None:
            self.hold.wait(10)
        return FakeOutput([("N° 000.045.181", 0.97, [[0, 0], [10, 0], [10, 5], [0, 5]])])


def start(engines, ready=True, max_queue=2, queue_wait_s=10.0):
    logs = []
    service = server.OcrService(TOKEN, engines, max_queue=max_queue, queue_wait_s=queue_wait_s, log=logs.append)
    if ready:
        service.ready.set()
    http = server.serve(service, host="127.0.0.1", port=0)
    base = f"http://127.0.0.1:{http.server_address[1]}"
    return service, http, base, logs


def call(base, path, body=None, token=TOKEN, content_type="image/jpeg", method=None, headers=None):
    request = urllib.request.Request(base + path, data=body, method=method or ("POST" if body is not None else "GET"))
    if token is not None:
        request.add_header("Authorization", f"Bearer {token}")
    if content_type and body is not None:
        request.add_header("Content-Type", content_type)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read()), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}"), dict(error.headers)


@pytest.fixture
def fake():
    engines = {"receipt": FakeEngine(), "digits": FakeEngine()}
    service, http, base, logs = start(engines)
    yield engines, service, base, logs
    http.shutdown()


# --- health -----------------------------------------------------------------


def test_health_is_503_until_the_warm_up_ran_and_200_after():
    engines = {"receipt": FakeEngine(), "digits": FakeEngine()}
    service, http, base, _ = start(engines, ready=False)
    try:
        status, body, _ = call(base, "/health", token=None)
        assert status == 503
        assert body["ok"] is False

        # A read before the warm-up is turned away as busy, not failed.
        status, body, headers = call(base, "/v1/read?profile=receipt", WARMUP)
        assert status == 503
        assert headers.get("Retry-After") == "5"

        service.warm_up()

        assert engines["receipt"].calls == 1 and engines["digits"].calls == 1
        status, body, _ = call(base, "/health", token=None)
        assert status == 200
        assert body["ok"] is True
        assert body["engine"] == "rapidocr"
        assert body["engineVersion"] == "3.9.2"
        assert body["profiles"] == ["receipt", "digits"]
    finally:
        http.shutdown()


# The deploy checks which build answers without a shell on the host: the
# commit comes from the image (Dockerfile: GIT_SHA → APP_COMMIT_SHA), and a
# value that is not a commit never reaches the body as if it were one.
def test_health_names_the_commit_the_image_was_built_from(monkeypatch):
    sha = "0123456789abcdef0123456789abcdef01234567"
    assert server.build_info({"APP_COMMIT_SHA": sha}) == {"version": "0123456", "commit": sha}
    assert server.build_info({"APP_COMMIT_SHA": f" {sha.upper()} "})["commit"] == sha
    for raw in ("", "abc12", "not-a-commit", "g" * 40, "a" * 41):
        assert server.build_info({"APP_COMMIT_SHA": raw}) == {"version": "dev", "commit": None}
    assert server.build_info({}) == {"version": "dev", "commit": None}

    monkeypatch.setattr(server, "BUILD", server.build_info({"APP_COMMIT_SHA": sha}))
    engines = {"receipt": FakeEngine(), "digits": FakeEngine()}
    service, http, base, _ = start(engines, ready=False)
    try:
        status, body, _ = call(base, "/health", token=None)
        assert status == 503
        assert body["commit"] == sha

        service.ready.set()
        status, body, _ = call(base, "/health", token=None)
        assert status == 200
        assert (body["version"], body["commit"]) == ("0123456", sha)
    finally:
        http.shutdown()


# --- authentication ---------------------------------------------------------


@pytest.mark.parametrize("token", [None, "", "t" * 39, "u" * 40, ("t" * 40) + "x"])
def test_401_without_the_token_or_with_a_wrong_one(fake, token):
    engines, _, base, logs = fake
    status, body, _ = call(base, "/v1/read?profile=receipt", WARMUP, token=token)
    assert status == 401
    assert body == {"error": "unauthorized"}
    assert engines["receipt"].calls == 0


def test_the_token_never_reaches_the_log_nor_does_the_text(fake):
    _, _, base, logs = fake
    call(base, "/v1/read?profile=receipt", WARMUP, token="secret-attempt-" + "x" * 30)
    status, _, _ = call(base, "/v1/read?profile=receipt", WARMUP)
    assert status == 200
    dumped = json.dumps(logs)
    assert "secret-attempt" not in dumped
    assert TOKEN not in dumped
    assert "045.181" not in dumped
    assert logs[-1]["profile"] == "receipt" and logs[-1]["status"] == 200
    assert {"inferMs", "queueMs", "bytes"} <= set(logs[-1])


# --- input limits -----------------------------------------------------------


def test_413_over_8_mb_before_reading_the_body(fake):
    import http.client
    from urllib.parse import urlsplit

    engines, _, base, _ = fake
    # Only the headers: the refusal must come from the declared length,
    # before a single byte of the body is read.
    connection = http.client.HTTPConnection(urlsplit(base).netloc, timeout=10)
    connection.putrequest("POST", "/v1/read?profile=receipt")
    connection.putheader("Authorization", f"Bearer {TOKEN}")
    connection.putheader("Content-Type", "image/jpeg")
    connection.putheader("Content-Length", str(server.MAX_BYTES + 1))
    connection.endheaders()
    response = connection.getresponse()
    assert response.status == 413
    assert json.loads(response.read()) == {"error": "too_large"}
    connection.close()
    assert engines["receipt"].calls == 0


def test_8_mb_exactly_is_accepted_up_to_the_decoder(fake):
    _, _, base, _ = fake
    # At the limit the body is read, and random bytes are not an image.
    status, payload, _ = call(base, "/v1/read?profile=receipt", random.Random(1).randbytes(server.MAX_BYTES))
    assert status == 400
    assert payload == {"error": "invalid_image"}


def test_413_over_25_megapixels_without_decoding(fake):
    from PIL import Image

    engines, _, base, _ = fake
    buffer = io.BytesIO()
    # 6000 × 5000 = 30 MP, a few KB once compressed: a decompression bomb.
    Image.new("L", (6000, 5000)).save(buffer, format="PNG")
    status, payload, _ = call(base, "/v1/read?profile=digits", buffer.getvalue(), content_type="image/png")
    assert status == 413
    assert payload == {"error": "too_many_pixels"}
    assert engines["digits"].calls == 0


def test_400_for_random_bytes(fake):
    engines, _, base, _ = fake
    status, payload, _ = call(base, "/v1/read?profile=receipt", random.Random(7).randbytes(4096))
    assert status == 400
    assert payload == {"error": "invalid_image"}
    assert engines["receipt"].calls == 0


@pytest.mark.parametrize(
    "path,content_type,code",
    [
        ("/v1/read?profile=fuel", "image/jpeg", "unknown_profile"),
        ("/v1/read", "image/jpeg", "unknown_profile"),
        ("/v1/read?profile=receipt", "application/json", "unsupported_media_type"),
    ],
)
def test_400_for_a_bad_profile_or_media_type(fake, path, content_type, code):
    _, _, base, _ = fake
    status, payload, _ = call(base, path, WARMUP, content_type=content_type)
    assert status == 400
    assert payload == {"error": code}


def test_the_error_body_never_echoes_the_input(fake):
    _, _, base, _ = fake
    status, payload, _ = call(base, "/v1/read?profile=<script>", WARMUP)
    assert status == 400
    assert "script" not in json.dumps(payload)


# --- concurrency ------------------------------------------------------------


def test_503_busy_when_the_queue_is_full():
    release = threading.Event()
    engines = {"receipt": FakeEngine(hold=release), "digits": FakeEngine()}
    _, http, base, _ = start(engines, max_queue=0)
    try:
        first = {}
        thread = threading.Thread(target=lambda: first.update(result=call(base, "/v1/read?profile=receipt", WARMUP)))
        thread.start()
        assert engines["receipt"].entered.wait(10)

        status, payload, headers = call(base, "/v1/read?profile=digits", WARMUP)
        assert status == 503
        assert payload == {"error": "busy"}
        assert headers.get("Retry-After") == "5"
        assert engines["digits"].calls == 0

        release.set()
        thread.join(10)
        assert first["result"][0] == 200

        # The slot is free again: the next read runs.
        status, _, _ = call(base, "/v1/read?profile=digits", WARMUP)
        assert status == 200
    finally:
        release.set()
        http.shutdown()


def test_503_busy_after_waiting_too_long_in_the_queue():
    release = threading.Event()
    engines = {"receipt": FakeEngine(hold=release), "digits": FakeEngine()}
    _, http, base, _ = start(engines, max_queue=2, queue_wait_s=0.3)
    try:
        thread = threading.Thread(target=lambda: call(base, "/v1/read?profile=receipt", WARMUP))
        thread.start()
        assert engines["receipt"].entered.wait(10)

        started = time.monotonic()
        status, payload, _ = call(base, "/v1/read?profile=digits", WARMUP)
        assert status == 503
        assert payload == {"error": "busy"}
        assert time.monotonic() - started >= 0.3
    finally:
        release.set()
        thread.join(10)
        http.shutdown()


def test_one_read_at_a_time():
    active = []
    peak = []
    lock = threading.Lock()

    class Counting(FakeEngine):
        def __call__(self, image):
            with lock:
                active.append(1)
                peak.append(len(active))
            time.sleep(0.05)
            with lock:
                active.pop()
            return super().__call__(image)

    engines = {"receipt": Counting(), "digits": Counting()}
    _, http, base, _ = start(engines, max_queue=8)
    try:
        threads = [threading.Thread(target=lambda: call(base, "/v1/read?profile=receipt", WARMUP)) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        assert max(peak) == 1
        assert engines["receipt"].calls == 5
    finally:
        http.shutdown()


def test_500_on_an_engine_failure_without_its_message(fake):
    engines, _, base, _ = fake

    def explode(image):
        raise RuntimeError("secret engine detail")

    engines["receipt"] = explode
    status, payload, _ = call(base, "/v1/read?profile=receipt", WARMUP)
    assert status == 500
    assert payload == {"error": "engine_error"}
    assert "secret" not in json.dumps(payload)


# --- the real engine --------------------------------------------------------

@pytest.fixture(scope="module")
def real():
    pytest.importorskip("rapidocr")
    engines = {profile: server.build_engine(profile, threads=2) for profile in server.PROFILES}
    service, http, base, _ = start(engines, ready=False)
    service.warm_up()
    yield base
    http.shutdown()


def test_the_warm_up_receipt_is_read_with_its_invoice_number(real):
    status, body, _ = call(real, "/v1/read?profile=receipt", WARMUP)
    assert status == 200
    assert body["profile"] == "receipt"
    assert body["engine"] == "rapidocr" and body["engineVersion"] == "3.9.2"
    assert (body["width"], body["height"]) == (1600, 1200)
    texts = [line["text"] for line in body["lines"]]
    assert any("000.045.181" in text for text in texts), texts
    assert any("27/09/2026" in text for text in texts), texts
    first = body["lines"][0]
    assert set(first) == {"text", "score", "box"}
    assert 0 <= first["score"] <= 1 and len(first["box"]) == 4


def test_the_digits_profile_reads_without_the_direction_classifier():
    pytest.importorskip("rapidocr")
    params = server.profile_params()
    assert params["digits"]["Global.use_cls"] is False
    assert "Global.use_cls" not in params["receipt"]


def test_the_models_on_disk_are_the_pinned_ones():
    pytest.importorskip("rapidocr")
    import fetch_models

    expected = {}
    for line in (HERE.parent / "models.sha256").read_text().splitlines():
        if line.strip():
            sha, name = line.split()
            expected[name] = sha

    found = {path.name: fetch_models.digest(path) for path in fetch_models.model_files()}
    assert found == expected


# --- refusals of a large body -------------------------------------------------
#
# Red before: the refusals after the headers (401, busy, warming_up, 400) were
# sent without reading the body and the connection closed with it unread. The
# kernel then answers the rest of the upload with a TCP RST, and the client
# (undici in the API) sees a socket error instead of the status: back-pressure
# was counted as an outage and a wrong token as a transient failure.

LARGE = 2 * 1024 * 1024


def post_large(base, path, token=TOKEN, size=LARGE, content_type="image/jpeg"):
    """Sends the whole body as a client does, then reads the answer: the status, or the socket error's name."""
    import http.client
    from urllib.parse import urlsplit

    connection = http.client.HTTPConnection(urlsplit(base).netloc, timeout=15)
    headers = {"Content-Type": content_type}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    try:
        connection.request("POST", path, body=random.Random(3).randbytes(size), headers=headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read() or b"{}"), dict(response.getheaders())
    except OSError as error:  # ConnectionResetError, BrokenPipeError, ...
        return type(error).__name__, None, {}
    finally:
        connection.close()


def test_a_wrong_token_with_a_large_body_is_received_as_401(fake):
    engines, _, base, _ = fake
    for _ in range(5):
        status, payload, _ = post_large(base, "/v1/read?profile=receipt", token="u" * 40)
        assert status == 401
        assert payload == {"error": "unauthorized"}
    assert engines["receipt"].calls == 0


def test_a_bad_profile_with_a_large_body_is_received_as_400(fake):
    _, _, base, _ = fake
    for _ in range(5):
        status, payload, _ = post_large(base, "/v1/read?profile=fuel")
        assert status == 400
        assert payload == {"error": "unknown_profile"}


def test_busy_with_a_large_body_is_received_as_503():
    release = threading.Event()
    engines = {"receipt": FakeEngine(hold=release), "digits": FakeEngine()}
    _, http, base, _ = start(engines, max_queue=0)
    try:
        thread = threading.Thread(target=lambda: call(base, "/v1/read?profile=receipt", WARMUP))
        thread.start()
        assert engines["receipt"].entered.wait(10)

        for _ in range(5):
            status, payload, headers = post_large(base, "/v1/read?profile=digits")
            assert status == 503
            assert payload == {"error": "busy"}
            assert headers.get("Retry-After") == "5"
        assert engines["digits"].calls == 0
    finally:
        release.set()
        thread.join(10)
        http.shutdown()


def test_warming_up_with_a_large_body_is_received_as_503():
    engines = {"receipt": FakeEngine(), "digits": FakeEngine()}
    _, http, base, _ = start(engines, ready=False)
    try:
        for _ in range(5):
            status, payload, headers = post_large(base, "/v1/read?profile=receipt")
            assert status == 503
            assert payload == {"error": "warming_up"}
            assert headers.get("Retry-After") == "5"
    finally:
        http.shutdown()
