FROM ollama/ollama:0.40.16
ARG READER_MODEL=qwen3:4b-instruct-2507-q4_K_M
ENV OLLAMA_MODELS=/opt/langy-models \
    OLLAMA_NO_CLOUD=1
RUN set -eu; \
    export OLLAMA_HOST=127.0.0.1:11434; \
    ollama serve >/tmp/ollama-build.log 2>&1 & \
    server_pid=$!; \
    trap 'kill "$server_pid" 2>/dev/null || true' EXIT; \
    for attempt in $(seq 1 45); do \
      if ollama list >/dev/null 2>&1; then break; fi; \
      sleep 1; \
    done; \
    ollama list >/dev/null || { cat /tmp/ollama-build.log; exit 1; }; \
    ollama pull "$READER_MODEL"; \
    rm -f /tmp/ollama-build.log
