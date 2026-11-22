#!/usr/bin/env bash
# Migrate a personal installation's complete data volume to an already mounted drive.
# This script never formats drives or removes the original Docker volume.
set -euo pipefail

die() { printf '%s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || die 'Run this script with sudo.'
[[ $# == 1 || ( $# == 2 && $2 == --tunnel ) ]] || die 'Usage: sudo bash scripts/migrate-storage.sh /mounted/drive [--tunnel]'
mount_root=$1
[[ $mount_root =~ ^/[a-zA-Z0-9_./-]+$ && $mount_root != / ]] || die 'Choose an absolute mount point without spaces or special characters.'
for command in docker findmnt mountpoint python3; do command -v "$command" >/dev/null || die "Required command missing: $command"; done
mount_root=$(readlink -f -- "$mount_root")
[[ $mount_root != / ]] || die 'Choose a separate mounted data drive, not the root filesystem.'
mountpoint -q -- "$mount_root" || die 'The destination drive is not mounted. Mount it before migrating.'
findmnt --mountpoint "$mount_root" --output SOURCE,TARGET,FSTYPE

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || die 'Create your personal .env file before migrating.'
# The migration edits .env; inherited overrides must not silently defeat it.
unset READER_DATA_SOURCE READER_STORAGE_ID
compose=(docker compose --env-file .env -f compose.yaml)
if [[ ${2:-} == --tunnel ]]; then compose+=(-f compose.tunnel.yaml); fi
"${compose[@]}" config --quiet
container=$("${compose[@]}" ps -q reader)
[[ -n $container ]] || die 'Start your existing reader before migrating so its source volume can be identified.'
volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "$container")
[[ -n $volume ]] || die 'The current reader is not using a Docker data volume; stopping to avoid overwriting an existing migration.'
image=$(docker inspect --format '{{.Image}}' "$container")
docker volume inspect "$volume" >/dev/null
destination=$mount_root/library
[[ ! -L $destination && ( ! -e $destination || -d $destination ) ]] || die 'The destination library must be a regular directory, not a symbolic link.'
if [[ -d $destination && -n $(find "$destination" -mindepth 1 -maxdepth 1 -print -quit) ]]; then die 'The destination library already contains files. Inspect it before retrying; no existing data was overwritten.'; fi

# Finish the image build before stopping the reader to limit downtime.
"${compose[@]}" build reader
mountpoint -q -- "$mount_root" || die 'The destination drive became unavailable.'
mkdir -p -- "$destination"
backup=.env.storage-before-$(date +%Y%m%d-%H%M%S)-$$
cp -p -- .env "$backup"
chmod 600 "$backup"
stopped=0
changed=0
recover() {
  local result=$1
  trap - ERR INT TERM
  if (( changed )); then cp -p -- "$backup" .env; fi
  if (( stopped )); then
    printf '%s\n' 'Migration failed. Restarting the original data volume.' >&2
    "${compose[@]}" up -d --no-deps reader || true
  fi
  printf '%s\n' "Original volume retained: $volume" "Settings backup: $backup" >&2
  exit "$result"
}
trap 'recover $?' ERR
trap 'recover 130' INT
trap 'recover 143' TERM
printf '%s\n' "Copying $volume to $destination. The reader will be temporarily unavailable."
stopped=1
"${compose[@]}" stop reader
docker run --rm --network none --user 0:0 --entrypoint /bin/sh \
  --mount "type=volume,source=$volume,target=/old,readonly" \
  --mount "type=bind,source=$destination,target=/new" \
  "$image" -c 'test -f /old/library.sqlite && cp -a /old/. /new/ && diff -qr --no-dereference /old /new'
mountpoint -q -- "$mount_root"
storage_id=$(python3 -c 'import uuid; print(uuid.uuid4())')
printf '%s\n' "$storage_id" > "$destination/.langy-storage-id"
chmod 444 "$destination/.langy-storage-id"
# Preserve all existing credentials and literal dollar signs. Do not source .env.
changed=1
python3 - "$destination" "$storage_id" <<'PY'
import os
import re
import sys
import tempfile
from pathlib import Path
path = Path('.env')
text = path.read_text()
text = re.sub(r'^[ \t]*(?:export[ \t]+)?(?:READER_DATA_SOURCE|READER_STORAGE_ID)[ \t]*=.*(?:\n|$)', '', text, flags=re.M)
original = path.stat()
temporary = None
try:
    with tempfile.NamedTemporaryFile(mode='w', dir='.', prefix='.env.storage-pending-', delete=False) as stream:
        temporary = stream.name
        os.fchmod(stream.fileno(), 0o600)
        os.fchown(stream.fileno(), original.st_uid, original.st_gid)
        stream.write(text.rstrip('\n') + f'\nREADER_DATA_SOURCE={sys.argv[1]}\nREADER_STORAGE_ID={sys.argv[2]}\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
finally:
    if temporary and os.path.exists(temporary): os.unlink(temporary)
PY
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-deps --wait --wait-timeout 60 reader
stopped=0
trap - ERR INT TERM
printf '%s\n' 'Storage migration completed. The original Docker volume remains as a backup.'
findmnt --target "$destination" --output SOURCE,TARGET,FSTYPE
df -hT "$destination"
docker inspect "$("${compose[@]}" ps -q reader)" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
