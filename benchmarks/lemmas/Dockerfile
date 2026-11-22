FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HF_HUB_DISABLE_XET=1 \
    STANZA_RESOURCES_DIR=/opt/benchmark-models/stanza \
    BENCHMARK_CORPORA=/opt/benchmark-corpora/answer-key.json \
    BENCHMARK_OUTPUT=/results HOME=/tmp
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 libstdc++6 && rm -rf /var/lib/apt/lists/*
# CPU-only PyTorch keeps the independent benchmark from requiring CUDA or a GPU.
RUN pip install --no-cache-dir torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
COPY benchmarks/lemmas/requirements.txt /app/benchmarks/lemmas/
RUN pip install --no-cache-dir -r /app/benchmarks/lemmas/requirements.txt \
    && pip install --no-cache-dir \
      https://github.com/explosion/spacy-models/releases/download/es_core_news_sm-3.8.0/es_core_news_sm-3.8.0-py3-none-any.whl \
      https://github.com/explosion/spacy-models/releases/download/pt_core_news_sm-3.8.0/pt_core_news_sm-3.8.0-py3-none-any.whl \
      https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl
COPY benchmarks/lemmas/models.json benchmarks/lemmas/prepare_models.py /app/benchmarks/lemmas/
RUN python /app/benchmarks/lemmas/prepare_models.py /opt/benchmark-models/stanza
COPY benchmarks/lemmas/core.py benchmarks/lemmas/sources.json benchmarks/lemmas/prepare_corpora.py /app/benchmarks/lemmas/
RUN python /app/benchmarks/lemmas/prepare_corpora.py /opt/benchmark-corpora
COPY language/app.py /app/language/app.py
COPY language/spanish_morphology.py /app/language/spanish_morphology.py
COPY benchmarks/lemmas/benchmark.py benchmarks/lemmas/challenge.json benchmarks/lemmas/spanish-future.json /app/benchmarks/lemmas/
RUN python /app/benchmarks/lemmas/benchmark.py --validate-only --split all
ENTRYPOINT ["python", "/app/benchmarks/lemmas/benchmark.py"]
