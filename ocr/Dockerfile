FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 LANGY_OCR_MODEL_DIR=/opt/ocr-models PADDLE_PDX_CACHE_HOME=/opt/ocr-cache PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 libgl1 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY install_models.py model-sources.json ./
# Fetch the recognition models during the build; scans then run offline.
RUN python install_models.py && useradd --system --uid 10001 --create-home langy && mkdir /opt/ocr-cache && chown -R langy:langy /opt/ocr-models /opt/ocr-cache
COPY paddle_pdf.py app.py ./
USER langy
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
