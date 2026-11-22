"""Build a reproducible answer key from pinned published UD dev/test annotations."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

from core import load_json, parse_conllu, sample_cases, validate_cases


def checked_download(url, digest, path):
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
        return path.read_bytes()
    with urllib.request.urlopen(url, timeout=90) as response:
        content = response.read(32 * 1024 * 1024 + 1)
    if len(content) > 32 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != digest:
        raise ValueError("Source size/checksum mismatch: " + url)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return content


def prepare(folder, local_sources=None):
    config = load_json(Path(__file__).with_name("sources.json"))
    folder = Path(folder); folder.mkdir(parents=True, exist_ok=True)
    cases, provenance = [], []
    for source in config["sources"]:
        identifier = source["repository"].split("/")[1]
        location = folder / identifier; location.mkdir(exist_ok=True)
        files = {}
        for item in source["files"]:
            if local_sources:
                content = (Path(local_sources) / identifier / item["path"]).read_bytes()
                if hashlib.sha256(content).hexdigest() != item["sha256"]:
                    raise ValueError("Local reference checksum mismatch: " + item["path"])
                (location / item["path"]).write_bytes(content)
            else:
                url = f"https://raw.githubusercontent.com/{source['repository']}/{source['commit']}/{item['path']}"
                content = checked_download(url, item["sha256"], location / item["path"])
            files[item["path"]] = content
        selections = {}
        for split, budget in [("dev", 400), ("test", 800)]:
            parsed, rejected = parse_conllu(files[f"{source['prefix']}-ud-{split}.conllu"].decode("utf-8"), source["language"], identifier, split)
            selected = sample_cases(parsed, budget); cases.extend(selected)
            selections[split] = {"eligible_sentences": len(parsed), "excluded_sentences": rejected,
                                 "selected_sentences": len(selected), "selected_source_words": sum(len(case["groups"]) for case in selected),
                                 "selected_lexical_components": sum(len(group["components"]) for case in selected for group in case["groups"])}
        metadata = {}
        for line in files["README.md"].decode("utf-8").splitlines():
            if ": " in line:
                key, value = line.split(": ", 1)
                if key in {"License", "Lemmas", "UPOS", "Genre", "Contributors"}:
                    metadata[key] = value
        provenance.append({**source, "upstream_metadata": metadata, "license_text": files["LICENSE.txt"].decode("utf-8"), "selection": selections})
    validate_cases(cases)
    result = {"version": 1, "selection": "SHA-256 ordering of sentence IDs; whole sentences, fixed lexical-component budgets; no selection based on model outputs.",
              "provenance": provenance, "cases": cases}
    (folder / "answer-key.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"Prepared {len(cases)} published reference sentences in {folder / 'answer-key.json'}", flush=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder")
    parser.add_argument("--local-sources")
    args = parser.parse_args()
    prepare(args.folder, args.local_sources)
