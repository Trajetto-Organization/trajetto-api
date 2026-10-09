# Benchmark-only OCR image (not product code): RapidOCR + ONNX Runtime on CPU,
# no PaddlePaddle. Models are fetched at build time so the measured cold load
# never includes a download.
#
#   docker build -t trajetto-ai-bench-ocr:3.9.2 scripts/ai-benchmark/ocr-server
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1

# opencv headless instead of the opencv-python RapidOCR declares (that one
# needs libGL); everything else is RapidOCR's own dependency list.
RUN pip install opencv-python-headless==4.12.0.88 onnxruntime==1.30.0 \
      pyclipper "numpy<3" six "Shapely!=2.0.4" PyYAML Pillow tqdm omegaconf requests colorlog \
 && pip install --no-deps rapidocr==3.9.2

WORKDIR /app
COPY server.py /app/server.py
RUN OCR_PREFETCH=1 python /app/server.py

EXPOSE 8080
CMD ["python", "/app/server.py"]
