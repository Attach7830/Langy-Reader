"""Build a local, POS-tagged Spanish index from checksum-pinned open data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import urllib.request


def word_key(value):
    import unicodedata
    return unicodedata.normalize("NFC", value).casefold()


def plain(value):
    return word_key(value).translate(str.maketrans("áéíóú", "aeiou"))


def entries(lines):
    rows = []
    ordinals = {}
    for line in lines:
        fields = line.split()
        if len(fields) != 3:
            raise ValueError("Malformed Spanish dictionary entry")
        form, lemma, tag = fields
        rows.append((form, lemma, tag))
        if tag.startswith("AO") and len(tag) >= 5 and tag[3:5] == "MS":
            ordinals.setdefault(lemma, set()).add(form)
    for form, lemma, tag in rows:
        pos = "VERB" if tag.startswith("V") else "NOUN" if tag.startswith("NC") else "ADJ" if tag.startswith(("AQ", "AO")) else None
        if tag.startswith("AO") and not any(char.isalpha() for char in lemma):
            # FreeLing uses a number for ordinals. Recover an attested masculine
            # citation form within that ordinal paradigm, without merging synonyms.
            singular = form[:-1] if form.endswith("s") else form
            variants = [form + "o", form, singular, singular[:-1] + "o" if singular.endswith("a") else singular]
            lemma = next((item for item in variants if item in ordinals.get(lemma, set())), form)
        if pos and any(char.isalpha() for char in lemma):
            yield word_key(form), plain(form), word_key(lemma), pos, tag


def build_index(target, sources, provenance):
    target = Path(target); target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="lexicon-", suffix=".sqlite", dir=target.parent)
    os.close(descriptor)
    try:
        with sqlite3.connect(temporary) as db:
            db.executescript("""CREATE TABLE forms(word TEXT, plain TEXT, lemma TEXT, pos TEXT, tag TEXT,
              PRIMARY KEY(word,lemma,tag)) WITHOUT ROWID;
              CREATE TABLE metadata(name TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;""")
            with db:
                for source in sources:
                    with Path(source).open(encoding="utf-8") as file:
                        db.executemany("INSERT OR IGNORE INTO forms VALUES(?,?,?,?,?)", entries(file))
                db.execute("CREATE INDEX forms_plain ON forms(plain,pos)")
                count = db.execute("SELECT count(*) FROM forms").fetchone()[0]
                db.execute("INSERT INTO metadata VALUES('provenance',?)", (json.dumps({**provenance, "entries": count}),))
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Spanish morphology index failed integrity check")
        # Docker builds as root and serves analysis as the unprivileged langy user.
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
        return count
    finally:
        Path(temporary).unlink(missing_ok=True)


def prepare(folder, cache=None):
    manifest = json.loads(Path(__file__).with_name("spanish-lexicon-sources.json").read_text())
    folder = Path(folder); sources = folder / "sources"; sources.mkdir(parents=True, exist_ok=True)
    entries_files = []
    for item in manifest["files"]:
        filename = Path(item["path"]).name
        cached = Path(cache, filename) if cache else sources / filename
        if cached.is_file():
            raw = cached.read_bytes()
        else:
            with urllib.request.urlopen(item["url"], timeout=60) as response:
                raw = response.read(item["size"] + 1)
        if len(raw) != item["size"] or hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise ValueError("Spanish morphology source checksum mismatch: " + filename)
        destination = sources / filename
        destination.write_bytes(raw)
        if filename.startswith("MM."):
            entries_files.append(destination)
    count = build_index(folder / "lexicon.sqlite", entries_files, manifest)
    (folder / "README.txt").write_text("\n".join([
        manifest["attribution"], "Original dictionary data: " + manifest["repository"],
        "Pinned revision: " + manifest["commit"], "Lexical data and this derived index: LGPL-LR.",
        "Index transformation: NFC/casefold normalization, open-class POS filtering, accent search index.",
        "Original source files, attribution and license are retained in sources/.", ""]))
    print(f"Indexed {count:,} tagged Spanish readings.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder")
    parser.add_argument("--cache")
    args = parser.parse_args()
    prepare(args.folder, args.cache)
