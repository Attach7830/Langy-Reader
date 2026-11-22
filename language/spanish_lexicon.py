"""Read grammatical candidates from a local index; never download during reading."""
import functools
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import threading
import unicodedata


def key(value):
    return unicodedata.normalize("NFC", value).casefold()


def plain(value):
    return key(value).translate(str.maketrans("áéíóú", "aeiou"))


def location():
    return Path(os.environ.get("LANGY_SPANISH_LEXICON", str(Path(os.environ.get("LANGY_MODELS", "/opt/models")) / "spanish-morphology/lexicon.sqlite")))


_connections = threading.local()


def connection():
    path = location().resolve()
    if not path.is_file():
        return None
    if getattr(_connections, "path", None) != path:
        if getattr(_connections, "db", None):
            _connections.db.close()
        _connections.db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        _connections.path = path
    return _connections.db


def decode(lemma, pos, tag):
    result = {"lemma": lemma, "pos": pos, "tag": tag}
    if pos == "VERB":
        result.update(mood=tag[2], tense=tag[3], person=tag[4], number=tag[5], gender=tag[6])
    elif pos == "NOUN":
        result.update(gender=tag[2], number=tag[3])
    elif pos == "ADJ":
        result.update(gender=tag[3], number=tag[4])
    return result


@functools.lru_cache(maxsize=16000)
def lookup_at(path, word, folded):
    db = connection()
    if db is None:
        return ()
    query = "SELECT lemma,pos,tag FROM forms WHERE plain=? AND pos='VERB' ORDER BY lemma,tag" if folded else "SELECT lemma,pos,tag FROM forms WHERE word=? ORDER BY lemma,tag"
    return tuple(decode(*row) for row in db.execute(query, (word,)))


def readings(word, folded=False):
    # Include the configured path in the cache key, including in isolated tests.
    if not location().is_file():
        return ()
    return lookup_at(str(location().resolve()), plain(word) if folded else key(word), folded)


def metadata():
    db = connection()
    if db is None:
        return {"available": False}
    source = json.loads(db.execute("SELECT value FROM metadata WHERE name='provenance'").fetchone()[0])
    return {"available": True, "source_commit": source["commit"], "entries": source["entries"],
            "source_manifest_sha256": hashlib.sha256(json.dumps(source["files"], sort_keys=True).encode()).hexdigest()}
