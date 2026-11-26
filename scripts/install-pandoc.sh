#!/bin/sh
set -eu
# Official static build embeds its data files, required by --sandbox.
case "$(uname -m)" in
  x86_64) arch=amd64; digest=c5f4720cdefb3f7bdc5d07202ef579feef0d1370773c873804dd8fdaa8c4f1b8 ;;
  aarch64|arm64) arch=arm64; digest=c692f3d78a415741bbbac4cdbbbe26fa7edca1f43d2301b982fbf4009cc8cf7f ;;
  *) echo 'EPUB conversion requires an amd64 or arm64 host.' >&2; exit 1 ;;
esac
prefix=${1:-/usr/local}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl -fL --retry 3 "https://github.com/jgm/pandoc/releases/download/3.14/pandoc-3.14-linux-$arch.tar.gz" -o "$work/pandoc.tgz"
echo "$digest  $work/pandoc.tgz" | sha256sum -c -
tar -xzf "$work/pandoc.tgz" -C "$work"
mkdir -p "$prefix/bin"
install -m 755 "$work/pandoc-3.14/bin/pandoc" "$prefix/bin/pandoc"

mkdir -p "$prefix/share/doc/langy-pandoc"
if [ ! -f "$prefix/share/doc/langy-pandoc/pandoc-COPYING.md" ]; then
  license_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../licenses" && pwd)
  cp "$license_dir/pandoc-COPYING.md" "$license_dir/pandoc-GPL-2.txt" "$prefix/share/doc/langy-pandoc/"
fi
cat > "$prefix/share/doc/langy-pandoc/SOURCE.txt" <<'SOURCE'
Pandoc 3.14, Copyright John MacFarlane and contributors.
GNU GPL version 2 or later. Distributed as a separate executable.
Corresponding source (including submodules and build instructions):
https://github.com/jgm/pandoc/tree/3.14
https://github.com/jgm/pandoc/releases/tag/3.14
https://pandoc.org/installing.html#compiling-from-source
Langy invokes the unmodified official static binary with a trusted Lua filter.
SOURCE
