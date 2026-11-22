"""Download pinned public model resources once, at benchmark image build time."""
import hashlib
import json
import os
from pathlib import Path
import sys

def prepare(folder):
    import stanza
    from stanza.resources.common import download_resources_json
    config = json.loads(Path(__file__).with_name("models.json").read_text())
    folder = Path(folder); folder.mkdir(parents=True, exist_ok=True)
    download_resources_json(str(folder), resources_version=config["stanza_resources_version"])
    resource = folder / "resources.json"
    if hashlib.sha256(resource.read_bytes()).hexdigest() != config["stanza_resources_sha256"]:
        raise ValueError("The pinned Stanza resource manifest changed; review it before benchmarking.")
    for language, processors in config["processors"].items():
        print(f"Downloading Stanza {language}: {processors}", flush=True)
        stanza.download(language, model_dir=str(folder), processors=processors, package=None,
                        resources_version=config["stanza_resources_version"], download_json=False, verbose=False)
    manifest = {"configuration": config, "model_files": {}}
    for path in sorted(folder.rglob("*.pt")):
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        manifest["model_files"][str(path.relative_to(folder))] = digest.hexdigest()
    (folder / "benchmark-models.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    prepare(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("STANZA_RESOURCES_DIR", "/opt/benchmark-models/stanza"))
