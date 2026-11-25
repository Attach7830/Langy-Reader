FROM python:3.12-slim-bookworm
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
COPY app.py ./
COPY spanish_morphology.py ./
COPY spanish_dictionary.py spanish_lexicon.py ./
COPY book_alignment.py ./
COPY vocabulary_filters.py ./
COPY pdf_ocr.py ./
COPY install_ocr_models.py ./
RUN python install_ocr_models.py
USER langy
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
