"""Run Langy's actual analyzer and an isolated Stanza candidate against fixed keys."""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import time
import uuid

from core import expand_challenge, load_json, normalized, score_case, summarize, utf16, validate_cases

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def package_versions():
    values = {}
    for name in ["spacy", "stanza", "torch", "numpy", "spacy-lookups-data", "fastapi"]:
        try:
            values[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            continue
    return values


def langy_analyzer(language, source):
    spec = importlib.util.spec_from_file_location("langy_benchmark_app", source)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module; spec.loader.exec_module(module)
    metadata = {"source_sha256": hashlib.sha256(Path(source).read_bytes()).hexdigest(),
                "name_filter": "Unmodified Langy PROPN/PER/PERSON/LOC/GPE exclusion", "model": "Han character scan"}
    if language != "zh":
        model, method = module.pipeline(language)
        expected = load_json(HERE / "models.json")["spacy_models"][language]
        if module.MODELS[language] != expected["package"] or model.meta["version"] != expected["version"]:
            raise ValueError("Langy's baseline model changed; update the benchmark model pins before comparing it.")
        metadata.update(model=module.MODELS[language], model_version=model.meta["version"], method=method)

    def analyze(text):
        result = module.analyze(module.Analysis(text=text, language=language))
        groups = []
        for token in result["tokens"]:
            lemmas = [token["lemma"]]
            if language == "es" and token["word"].casefold() in {"al", "del"}:
                lemmas = ["a" if token["word"].casefold() == "al" else "de", "el"]
            elif language == "pt" and token["pos"] == "ADP" and " " in token["lemma"]:
                lemmas = token["lemma"].split()
            groups.append({"from": token["from"], "to": token["to"],
                           "components": [{"lemma": normalized(lemma), "upos": token["pos"] or "X", "excluded": token["properName"]} for lemma in lemmas]})
        return {"groups": groups, "inventory": sorted(normalized(lemma) for lemma in result["lemmas"])}
    return analyze, metadata


def stanza_analyzer(language, folder, threads):
    import torch
    import stanza
    torch.set_num_threads(threads)
    torch.manual_seed(0)
    config = load_json(HERE / "models.json")
    # The resource JSON and all model files were downloaded at build time. No inference-time downloads.
    resource_file = Path(folder) / "resources.json"
    if hashlib.sha256(resource_file.read_bytes()).hexdigest() != config["stanza_resources_sha256"]:
        raise ValueError("Stanza model manifest does not match the pinned configuration")
    pipeline = stanza.Pipeline(language, dir=folder, processors=config["processors"][language],
                               package=None, use_gpu=False, download_method=None, verbose=False)

    def analyze(text):
        doc = pipeline(text); groups, terms = [], set()
        for sentence in doc.sentences:
            for token in sentence.tokens:
                words = [word for word in token.words if any(char.isalpha() for char in word.text)]
                if not words:
                    continue
                values = [{"lemma": normalized(word.lemma or word.text), "upos": word.upos or "X", "excluded": word.upos == "PROPN"} for word in words]
                groups.append({"from": utf16(text[:token.start_char]), "to": utf16(text[:token.end_char]), "components": values})
                terms.update(word["lemma"] for word in values if not word["excluded"])
        return {"groups": groups, "inventory": sorted(terms)}
    return analyze, {"model": config["processors"][language], "resources_version": config["stanza_resources_version"],
                     "name_filter": "Stanza UPOS=PROPN; NER is not included", "device": "cpu"}


def worker(args):
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["OPENBLAS_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    started = time.perf_counter()
    if args.worker_engine == "langy":
        analyze, metadata = langy_analyzer(args.worker_language, args.langy_source)
    else:
        analyze, metadata = stanza_analyzer(args.worker_language, args.stanza_models, args.threads)
    load_seconds = time.perf_counter() - started
    warmup = {"es": "Esta es una frase breve para preparar el modelo.", "pt": "Esta é uma frase simples para preparar o modelo.",
              "en": "This is a short sentence to warm up the model.", "zh": "我读书。"}
    analyze(warmup[args.worker_language])
    rows = []
    for case in load_json(args.worker_key)["cases"]:
        if case["language"] != args.worker_language:
            continue
        started = time.perf_counter(); prediction = analyze(case["text"])
        prediction["milliseconds"] = (time.perf_counter() - started) * 1000
        rows.append(score_case(case, prediction))
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 * 1024 if sys.platform == "darwin" else 1024)
    result = {"engine": args.worker_engine, "language": args.worker_language, "rows": rows,
              "metadata": {**metadata, "packages": package_versions(), "load_seconds": load_seconds,
                           "peak_worker_rss_mib": peak, "threads": args.threads}}
    Path(args.worker_output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


def selected_key(args):
    challenge = load_json(HERE / "challenge.json")
    cases, provenance = [], {"challenge": {key: value for key, value in challenge.items() if key != "cases"}}
    if args.suite in {"all", "challenge"}:
        cases.extend(expand_challenge(challenge))
    if args.suite in {"all", "ud"}:
        path = Path(args.corpora)
        if not path.is_file():
            raise ValueError("Published answer key missing. Build the benchmark image or run prepare_corpora.py first.")
        data = load_json(path); cases.extend(data["cases"])
        provenance["ud"] = {key: value for key, value in data.items() if key != "cases"}
    languages = args.languages.split(",")
    if not languages or any(language not in {"es", "pt", "en", "zh"} for language in languages):
        raise ValueError("Choose languages from es,pt,en,zh")
    cases = [case for case in cases if case["language"] in languages and (args.split == "all" or case["split"] == args.split)]
    validate_cases(cases)
    if not cases:
        raise ValueError("No reference cases match the selected suite, language and split")
    return {"version": 1, "provenance": provenance, "cases": cases}


def markdown(report):
    def percent(value):
        return "—" if value is None else f"{value * 100:.2f}%"
    lines = ["# Langy lemma benchmark", "", f"Run: {report['run_id']}", "",
             "Source-word accuracy compares the complete lemma multiset at each annotated surface span, including attached-pronoun/contraction components. It is not the standard UD token-level metric.", "",
             "| Suite | Split | Language | Analyzer | Cases | Source-word accuracy | Inventory F1 | False entries | Missing entries | Inference seconds | Peak worker MiB |",
             "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for row in report["summaries"]:
        values = [row["suite"], row["split"], row["language"], row["engine"], str(row["cases"]), percent(row["accuracy"]), percent(row["inventory_f1"]),
                  str(row["false_entries"]) if row["false_entries"] is not None else "—", str(row["missed_entries"]) if row["missed_entries"] is not None else "—",
                  f"{row['milliseconds'] / 1000:.2f}", f"{row['peak_worker_rss_mib']:.1f}"]
        lines.append("| " + " | ".join(values) + " |")
    lines += ["", "- UD inventories exclude annotated PROPN words; Langy retains its real production entity filter. Stanza excludes PROPN and has no NER in this candidate. False name exclusions and missed names are counted in report.json.",
              "- False/missing entries count (sentence, lemma) errors, so one rare mistake is not hidden by frequent correct words. Inventory F1 uses the union within each suite/language/split.",
              "- Challenge sentences are original assistant-authored targets, not independently human-adjudicated. Inventory scores are omitted for these partially annotated sentences.",
              "- Published UD annotations are the upstream reference, not infallible truth. Their training/evaluation conventions and non-literary domains limit conclusions about novels. The dev/test split is the published split; this is not a claim of unseen upstream training data.",
              "- Runtime is warmed CPU inference on identical texts. Load time, package/model identities, source hashes, unaligned spans and potential lemma merges are in report.json. Each engine/language runs in a fresh process; peak RSS includes its full worker and model load.",
              "- Disagreements are in errors.csv. The exact answer key is in answer-key.json; source licensing/selection metadata is retained there.",
              "- No production model or library data was changed. The runner used local NLP models without LLM or paid API calls.", ""]
    return "\n".join(lines)


def run(args):
    key = selected_key(args)
    counts = {}
    for case in key["cases"]:
        label = f"{case['suite']}/{case['language']}/{case['split']}"
        counts[label] = counts.get(label, 0) + len(case["groups"])
    if args.validate_only:
        print(json.dumps({"cases": len(key["cases"]), "source_word_targets": counts}, indent=2)); return
    engines = list(dict.fromkeys(args.engines.split(",")))
    if not engines or any(engine not in {"langy", "stanza"} for engine in engines):
        raise ValueError("Choose engines from langy,stanza")
    if engines == ["stanza"] and all(case["language"] == "zh" for case in key["cases"]):
        raise ValueError("Mandarin character checks use the Langy character scanner, not Stanza lemmas.")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:6]
    folder = Path(args.output).resolve() / run_id; folder.mkdir(parents=True)
    key_path = folder / "answer-key.json"
    key_path.write_text(json.dumps(key, ensure_ascii=False, indent=2) + "\n")
    results = []
    for engine in engines:
        for language in dict.fromkeys(case["language"] for case in key["cases"]):
            if language == "zh" and engine == "stanza":
                continue
            target = folder / f"{engine}-{language}.json"
            command = [sys.executable, str(Path(__file__).resolve()), "--worker-engine", engine, "--worker-language", language,
                       "--worker-key", str(key_path), "--worker-output", str(target), "--stanza-models", args.stanza_models,
                       "--langy-source", args.langy_source, "--threads", str(args.threads)]
            print(f"Running {engine} / {language} in an isolated CPU process…", flush=True)
            result = subprocess.run(command, capture_output=True, text=True)
            (folder / f"{engine}-{language}.log").write_text(result.stdout + result.stderr)
            if result.returncode:
                raise RuntimeError(f"{engine}/{language} failed. See {folder / (engine + '-' + language + '.log')}. No complete comparison was published.")
            results.append(load_json(target))
    summaries = []
    for result in results:
        buckets = {}
        for row in result["rows"]:
            buckets.setdefault((row["suite"], row["split"]), []).append(row)
        for (suite, split), rows in buckets.items():
            summaries.append({"engine": result["engine"], "language": result["language"], "suite": suite, "split": split,
                              **summarize(rows), "peak_worker_rss_mib": result["metadata"]["peak_worker_rss_mib"]})
    report = {"version": 1, "run_id": run_id, "key_sha256": hashlib.sha256(key_path.read_bytes()).hexdigest(),
              "platform": platform.platform(), "cpu_count": os.cpu_count(), "threads": args.threads,
              "summaries": summaries, "models": [{key: value for key, value in result.items() if key != "rows"} for result in results]}
    manifest = Path(args.stanza_models) / "benchmark-models.json"
    if manifest.is_file():
        report["stanza_model_hashes"] = load_json(manifest)
    (folder / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (folder / "report.md").write_text(markdown(report))
    with (folder / "errors.csv").open("w", newline="", encoding="utf-8") as file:
        writer = csv.writer(file); writer.writerow(["engine", "language", "suite", "split", "case", "error_type", "form", "from_utf16", "to_utf16", "expected", "predicted", "context"])
        def write_error(engine, row, kind, form, expected, actual, start="", end=""):
            values = [engine, row["language"], row["suite"], row["split"], row["id"], kind, form, str(start), str(end),
                      json.dumps(expected, ensure_ascii=False), json.dumps(actual, ensure_ascii=False), row["text"]]
            writer.writerow(["'" + value if value.startswith(("=", "+", "-", "@")) else value for value in values])
        for result in results:
            for row in result["rows"]:
                for error in row["mismatches"]:
                    write_error(result["engine"], row, "lemma", error["form"], error["expected"], error["predicted"], error["from"], error["to"])
                for error in row["name_errors"]:
                    write_error(result["engine"], row, "name_exclusion", error["form"], error["expected_excluded"], error["predicted_excluded"], error["from"], error["to"])
                for error in row["alignment_errors"]:
                    write_error(result["engine"], row, "alignment", "", [], [word["lemma"] for word in error["components"]], error["from"], error["to"])
                for term in row["extra"]:
                    write_error(result["engine"], row, "extra_inventory_entry", term, [], [term])
                for term in row["missing"]:
                    write_error(result["engine"], row, "missing_inventory_entry", term, [term], [])
    latest = folder.parent / f".LATEST-{run_id}.tmp"
    latest.write_text(run_id + "\n"); latest.replace(folder.parent / "LATEST.txt")
    print(markdown(report), flush=True)
    print(f"Reports saved in {folder}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--languages", default="es,pt,en,zh", help="Comma-separated es,pt,en,zh")
    parser.add_argument("--engines", default="langy,stanza")
    parser.add_argument("--suite", choices=["all", "challenge", "ud"], default="all")
    parser.add_argument("--split", choices=["dev", "test", "all"], default="test")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--output", default=os.environ.get("BENCHMARK_OUTPUT", str(ROOT / "benchmark-results")))
    parser.add_argument("--corpora", default=os.environ.get("BENCHMARK_CORPORA", "/opt/benchmark-corpora/answer-key.json"))
    parser.add_argument("--stanza-models", default=os.environ.get("STANZA_RESOURCES_DIR", "/opt/benchmark-models/stanza"))
    parser.add_argument("--langy-source", default=str(ROOT / "language" / "app.py"))
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--worker-engine", choices=["langy", "stanza"], help=argparse.SUPPRESS)
    parser.add_argument("--worker-language", help=argparse.SUPPRESS)
    parser.add_argument("--worker-key", help=argparse.SUPPRESS)
    parser.add_argument("--worker-output", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not 1 <= args.threads <= 64:
        parser.error("threads must be from 1 to 64")
    try:
        worker(args) if args.worker_engine else run(args)
    except (ValueError, OSError, RuntimeError, ImportError) as error:
        print(str(error), file=sys.stderr); return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
