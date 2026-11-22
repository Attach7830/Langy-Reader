#!/usr/bin/env bash
set -euo pipefail
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project"
if [[ ${1:-} == --help ]]; then
  exec python3 benchmarks/lemmas/benchmark.py --help
fi
command -v docker >/dev/null || { echo 'Docker and Docker Compose are required for the benchmark.' >&2; exit 1; }
docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
  if [[ $(id -u) != 0 ]] && command -v sudo >/dev/null; then docker_command=(sudo docker); fi
  "${docker_command[@]}" info >/dev/null
fi
mkdir -p benchmark-results
uid=${SUDO_UID:-$(id -u)}
gid=${SUDO_GID:-$(id -g)}
if [[ $(id -u) == 0 && -n ${SUDO_UID:-} ]]; then chown "$uid:$gid" benchmark-results; fi
# This standalone project does not load the reader's .env, mount its library, or stop its services.
"${docker_command[@]}" compose --env-file /dev/null -f compose.benchmark.yaml run --rm --build \
  --user "$uid:$gid" benchmark "$@"
echo "Reports are in $project/benchmark-results (LATEST.txt identifies the newest complete run)."
