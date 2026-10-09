# trajetto-ai: the OCR service of the AI readings (ADR 0010, decision 14.1).
# RapidOCR on ONNX Runtime, CPU only, no PaddlePaddle. Internal network only:
# no Traefik, no published port, no egress (compose.production.yaml).
#
#   docker build -t trajetto-ai infra/ai-ocr                 runtime image
#   docker build --target test infra/ai-ocr                  runs the pytest suite
#
# Base pinned by digest (INFRA-16: a tag can be re-pushed, a digest cannot).
# The index digest of python:3.12-slim on 05/10/2026; Dependabot moves it.
FROM python:3.12-slim@sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d AS base

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Every package pinned AND hashed; rapidocr without its declared deps (it
# asks for opencv-python, which needs libGL: the headless build replaces it).
COPY requirements.txt requirements-rapidocr.txt ./
RUN pip install --require-hashes --no-deps -r requirements.txt \
 && pip install --require-hashes --no-deps -r requirements-rapidocr.txt

# Weights fetched HERE, never on the first boot, and verified against the
# versioned SHA-256 list: two replicas always run the same bytes and the
# boot needs no network. The exact set is checked (fetch_models.py), then
# sha256sum -c as the standard second opinion.
COPY models.sha256 fetch_models.py server.py ./
RUN python fetch_models.py \
 && cd "$(python -c 'import pathlib, rapidocr; print(pathlib.Path(rapidocr.__file__).parent / "models")')" \
 && sha256sum -c /app/models.sha256

COPY warmup.jpg ./

# --- tests: built by CI (`--target test`), never shipped ---------------------
FROM base AS test
COPY requirements-test.txt ./
RUN pip install --require-hashes --no-deps -r requirements-test.txt
COPY tests ./tests
# As the runtime user, so a test that needs to write somewhere fails here too.
USER 10001
RUN python -m pytest -q -p no:cacheprovider tests

# --- runtime ------------------------------------------------------------------
FROM base AS runtime

# Never root: the container decodes images that come from outside. With
# read_only + tmpfs /tmp in the compose file, nothing here is writable.
USER 10001

EXPOSE 8080

# /health answers 200 only after both profiles loaded and read warmup.jpg.
# Python, because the slim image has no wget/curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"]

CMD ["python", "/app/server.py"]
