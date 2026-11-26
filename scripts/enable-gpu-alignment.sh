#!/usr/bin/env bash
# Run with the same Docker permissions used for the rest of the Langy stack.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

compose=(docker compose -f compose.yaml)
for overlay in "$@"; do
  if [[ ! -f "$overlay" ]]; then
    printf 'Compose file not found: %s\n' "$overlay" >&2
    exit 1
  fi
  compose+=(-f "$overlay")
done
compose+=(-f compose.gpu.yaml)

# The existing services keep running during the build and CUDA inference check.
"${compose[@]}" build language
"${compose[@]}" run --rm --no-deps language python -m whisper_runtime

reader_running=$("${compose[@]}" ps --status running -q reader)
resume_reader() {
  if [[ -n "$reader_running" ]]; then
    "${compose[@]}" start reader
  fi
}
trap resume_reader EXIT
if [[ -n "$reader_running" ]]; then
  "${compose[@]}" stop reader
fi
"${compose[@]}" up -d --no-deps --wait --wait-timeout 90 language
resume_reader
trap - EXIT
printf 'GPU alignment enabled. Include -f compose.gpu.yaml when updating language.\n'
