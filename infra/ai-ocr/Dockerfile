# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# trajetto-ai: the OCR service of the AI readings (ADR 0010, decision 14.1).
# RapidOCR on ONNX Runtime, CPU only, no PaddlePaddle. Internal network only:
# a Dokploy Application with no domain and no published port, reached by the
# API at http://<appName>:8080 on dokploy-network (docs/deploy.md).
#
#   docker build -t trajetto-ai infra/ai-ocr                 runtime image (the last stage)
#   docker build --target test infra/ai-ocr                  runs the pytest suite
#
# The build reaches only Docker Hub (the base, by digest) and PyPI (hashed
# wheels): the models are in models/, and the RUN that checks them has no
# network.
#
# The layers are cut for the server that pulls them. The staging VPS pulls
# GHCR blobs over an IPv6 route that resets connections mid-download, and
# Docker restarts a broken layer from zero while keeping the finished ones.
# The image used to be ONE 145 MB pip layer — nothing survived between
# Dokploy's retries (run 40551925038 failed 3/3 on it) and a Pillow bump
# re-shipped all of it — with the models in the same layer as server.py, so
# an edit to the server re-downloaded the weights. Now: five pip layers in
# the order they change (requirements.txt lists them), the models in a layer
# nothing else invalidates, and the code last.
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

# Every package pinned AND hashed, and installed with --no-deps: the closure
# is resolved by hand (rapidocr asks for opencv-python, which needs libGL;
# the headless build replaces it). One RUN per requirements file, least
# likely to change first, each file bind-mounted instead of COPY'd: copying
# them all up front would put every layer behind the most edited file. A
# bump re-ships its own layer and the ones after it, never the ones before.
#
# Three of those RUNs also delete, in the SAME layer, what the wheel ships
# and the service never imports (a later RUN would only hide the files:
# layers are additive, and every pull would still carry them). Checked on
# 28/10/2026 against server.py, fetch_models.py and every installed package:
# - opencv: the Haar cascade XMLs (cv2/data/*.xml, 9.8 MB). The OCR uses no
#   cascade; cv2/data/__init__.py stays, so `cv2.data` still imports.
# - onnxruntime: tools/, transformers/ and quantization/ (7.7 MB), model
#   conversion and tuning scripts. onnxruntime/__init__.py reaches
#   transformers/ only from print_debug_info() on a CUDA build.
# - numpy: its test suites (13.8 MB). numpy.testing imports one helper from
#   them (numpy/_core/tests/_natype.py), which stays; the RUN imports
#   numpy.testing to prove it.
# Measured: 536 → 501 MB unpacked, 203 → 196 MB compressed. The `test`
# stage below runs pytest and both engines on this same base, and CI starts
# the runtime image before pushing it (deploy.yml, "Smoke test the AI image").
RUN --mount=type=bind,source=requirements-opencv.txt,target=/tmp/requirements.txt \
    pip install --require-hashes --no-deps -r /tmp/requirements.txt \
    && site="$(python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')" \
    && rm -f "$site"/cv2/data/*.xml
RUN --mount=type=bind,source=requirements-onnxruntime.txt,target=/tmp/requirements.txt \
    pip install --require-hashes --no-deps -r /tmp/requirements.txt \
    && site="$(python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')" \
    && rm -rf "$site/onnxruntime/tools" "$site/onnxruntime/transformers" "$site/onnxruntime/quantization"
RUN --mount=type=bind,source=requirements-rapidocr.txt,target=/tmp/requirements.txt \
    pip install --require-hashes --no-deps -r /tmp/requirements.txt
RUN --mount=type=bind,source=requirements-numpy.txt,target=/tmp/requirements.txt \
    pip install --require-hashes --no-deps -r /tmp/requirements.txt \
    && site="$(python -c 'import sysconfig; print(sysconfig.get_path("purelib"))')" \
    && find "$site/numpy" -path '*/tests/*' ! -path '*/numpy/_core/tests/_natype.py' -delete \
    && find "$site/numpy" -type d -name tests -empty -delete \
    && python -c 'import numpy.testing'
RUN --mount=type=bind,source=requirements.txt,target=/tmp/requirements.txt \
    pip install --require-hashes --no-deps -r /tmp/requirements.txt

# --- models: verified here, offline, shipped as one layer of their own ------
# The wheel ships the PP-OCRv6 pair and the direction classifier; the
# PP-OCRv5 pair of the receipt profile is versioned in models/ (4.8 and
# 7.9 MB, Apache-2.0, from RapidOCR 3.9.2's own list, the URLs in its
# default_models.yaml). It used to be downloaded HERE, on every build
# without cache, from a host in China (www.modelscope.cn): one request, no
# retry, 60 s of timeout, a CI job hanging on that host. Now the build
# reaches no host but PyPI and Docker Hub, and this RUN has no network at
# all: if RapidOCR ever tried to download a model, the build would fail here
# instead of pulling it.
#
# Never on the first boot either: two replicas always run the same bytes and
# the boot needs no network. The exact set is checked (fetch_models.py
# builds both profiles' engines, which find every file in place, and
# compares the folder with models.sha256), then sha256sum -c as the standard
# second opinion. A deliberate model change: fetch_models.py's docstring.
#
# Only what is not the wheel's goes to /out (the wheel's own models are
# already in the rapidocr layer), under its full path, owned by root, 0644,
# every mtime at the epoch: the same weights always make the same bytes —
# the same layer they made when they were downloaded here.
# This stage needs server.py (fetch_models builds both profiles' engines),
# so a server edit reruns it in CI; the `COPY --link` of /out below is cached
# by the content it copies, not by the stage that produced it, so the image
# keeps the very same models layer and the server never pulls it again.
FROM base AS models
COPY models.sha256 fetch_models.py server.py ./
RUN --network=none --mount=type=bind,source=models,target=/tmp/vendored-models \
    set -eu; \
    models="$(python -c 'import pathlib, rapidocr; print(pathlib.Path(rapidocr.__file__).resolve().parent / "models")')"; \
    shipped="$(ls -A "$models")"; \
    cp /tmp/vendored-models/*.onnx "$models"/; \
    python fetch_models.py; \
    (cd "$models" && sha256sum -c /app/models.sha256); \
    mkdir -p "/out$models"; \
    for file in "$models"/*; do \
      name="$(basename "$file")"; \
      if ! printf '%s\n' "$shipped" | grep -qxF "$name"; then cp "$file" "/out$models/$name"; fi; \
    done; \
    chown -R 0:0 /out; \
    chmod -R u=rwX,go=rX /out; \
    find /out -exec touch -h -d @0 {} +

# --- app: what the tests and the runtime both run ----------------------------
# `--link`: each COPY is a layer of its own, rebased onto whatever is below
# it instead of depending on it — a bump in the pip layers above leaves the
# models layer, and the code layers, with the digests they already had.
FROM base AS app
COPY --link --from=models /out/ /
COPY --link models.sha256 fetch_models.py warmup.jpg ./
COPY --link server.py ./

# --- tests: built by CI (`--target test`), never shipped ---------------------
FROM app AS test
RUN --mount=type=bind,source=requirements-test.txt,target=/tmp/requirements.txt \
    pip install --require-hashes --no-deps -r /tmp/requirements.txt
COPY tests ./tests
# As the runtime user, so a test that needs to write somewhere fails here too.
USER 10001
RUN python -m pytest -q -p no:cacheprovider tests

# --- runtime (the last stage: what a build without --target produces) --------
FROM app AS runtime

# Never root: the container decodes images that come from outside. With a
# read-only root filesystem and a tmpfs /tmp (when the deploy sets them: the
# Dokploy Application has no field for it, docs/deploy.md), nothing here is
# writable.
USER 10001

EXPOSE 8080

# /health answers 200 only after both profiles loaded and read warmup.jpg.
# Python, because the slim image has no wget/curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"]

# The commit this image was built from (deploy.yml passes GIT_SHA), which
# GET /health reports as `version`/`commit`. Declared LAST: a build arg
# declared earlier would be in the cache key of every RUN after it, and each
# commit would rebuild the layers above instead of reusing them. It changes
# the image config only, never a layer. Empty in a local build ("dev").
ARG GIT_SHA=""
ENV APP_COMMIT_SHA=${GIT_SHA}

CMD ["python", "/app/server.py"]
