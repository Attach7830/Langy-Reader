FROM python:3.12-slim-bookworm AS cuda-libraries
COPY requirements-cuda.txt /tmp/requirements-cuda.txt
RUN pip install --no-cache-dir --no-deps --target /opt/cuda-libraries -r /tmp/requirements-cuda.txt
ENV LD_LIBRARY_PATH=/opt/cuda-libraries/nvidia/cublas/lib:/opt/cuda-libraries/nvidia/cudnn/lib:/opt/cuda-libraries/nvidia/cuda_nvrtc/lib

FROM python:3.12-slim-bookworm AS language-base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 LANGY_MODELS=/opt/models HF_HUB_DISABLE_XET=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates ocrmypdf tesseract-ocr-all && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m spacy download es_core_news_sm \
    && python -m spacy download en_core_web_sm \
    && python -m spacy download pt_core_news_sm
COPY install_models.py ./
ARG WHISPER_MODEL=small
ENV LANGY_WHISPER_MODEL=${WHISPER_MODEL}
RUN python install_models.py && useradd --system --uid 10001 --create-home langy
COPY prepare_spanish_lexicon.py spanish-lexicon-sources.json ./
RUN python prepare_spanish_lexicon.py /opt/models/spanish-morphology
COPY install_ocr_models.py ./
RUN python install_ocr_models.py
COPY app.py whisper_runtime.py spanish_morphology.py spanish_dictionary.py spanish_lexicon.py book_alignment.py vocabulary_filters.py pdf_ocr.py ./
USER langy
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

FROM language-base AS gpu
COPY --from=cuda-libraries /opt/cuda-libraries /opt/cuda-libraries
ENV LD_LIBRARY_PATH=/opt/cuda-libraries/nvidia/cublas/lib:/opt/cuda-libraries/nvidia/cudnn/lib:/opt/cuda-libraries/nvidia/cuda_nvrtc/lib

# Keep the ordinary build CPU-only: unused CUDA stages are skipped by BuildKit.
FROM language-base AS cpu
