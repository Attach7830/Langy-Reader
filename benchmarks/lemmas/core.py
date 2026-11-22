"""Reference-key parsing and scoring; deliberately independent of either NLP model."""
from collections import defaultdict
import hashlib
import json
import unicodedata


def normalized(value):
    return unicodedata.normalize("NFC", value).casefold()


def utf16(value):
    return len(value.encode("utf-16-le")) // 2


def lexical(value):
    return any(char.isalpha() for char in value)


def components(values):
    return [{"lemma": normalized(lemma), "upos": upos} for lemma, upos in values]


def target_offset(text, form, cursor, character=False):
    def word_character(char):
        return char.isalnum() or char == "_" or unicodedata.category(char).startswith("M")
    while True:
        start = text.find(form, cursor)
        if start < 0:
            return -1
        end = start + len(form)
        if character or ((start == 0 or not word_character(text[start - 1])) and (end == len(text) or not word_character(text[end]))):
            return start
        cursor = start + 1


def expand_challenge(document):
    """Locate explicitly annotated targets, never generate the expected lemmas."""
    cases = []
    for raw in document["cases"]:
        case = {key: value for key, value in raw.items() if key != "answers"}
        case.update(suite="characters" if raw.get("kind") == "characters" else document.get("suite", "challenge"), complete=raw.get("kind") == "characters", groups=[])
        cursors = {}
        for answer in raw["answers"]:
            form, expected = answer
            start = target_offset(raw["text"], form, cursors.get(form, 0), raw.get("kind") == "characters")
            if start < 0:
                raise ValueError(f"{raw['id']}: target {form!r} is missing or out of order")
            end = start + len(form)
            case["groups"].append({"form": form, "from": utf16(raw["text"][:start]),
                                   "to": utf16(raw["text"][:end]), "components": components(expected)})
            cursors[form] = end
        case["groups"].sort(key=lambda group: group["from"])
        cases.append(case)
    validate_cases(cases)
    return cases


def parse_conllu(content, language, source, split):
    """Keep original surface spans, including MWT parents; ignore empty nodes."""
    cases, rejected = [], []
    for block in content.strip().split("\n\n"):
        comments, rows = {}, []
        for line in block.splitlines():
            if line.startswith("# ") and " = " in line:
                key, value = line[2:].split(" = ", 1)
                comments[key] = value
            elif line and not line.startswith("#"):
                cols = line.split("\t")
                if len(cols) != 10:
                    raise ValueError("Invalid CoNLL-U row")
                if "." not in cols[0]:
                    rows.append(cols)
        if not rows:
            continue
        identifier = comments.get("sent_id", str(len(cases) + len(rejected)))
        try:
            by_id = {int(row[0]): row for row in rows if row[0].isdigit()}
            surfaces, covered = [], 0
            for row in rows:
                if "-" in row[0]:
                    first, last = map(int, row[0].split("-"))
                    children = [by_id[index] for index in range(first, last + 1)]
                    surfaces.append((row, children)); covered = last
                elif int(row[0]) > covered:
                    surfaces.append((row, [row]))
            text = comments.get("text")
            if not text:
                text = "".join(row[1] + ("" if "SpaceAfter=No" in row[9].split("|") else " ") for row, _ in surfaces).rstrip()
            cursor, groups = 0, []
            for row, children in surfaces:
                start = text.find(row[1], cursor)
                if start < 0 or text[cursor:start].strip():
                    raise ValueError("surface form does not align with original text")
                end = start + len(row[1]); cursor = end
                words = [child for child in children if lexical(child[1])]
                if not words:
                    continue
                if any(child[2] == "_" or child[3] == "_" for child in words):
                    raise ValueError("missing lexical lemma or POS annotation")
                groups.append({"form": row[1], "from": utf16(text[:start]), "to": utf16(text[:end]),
                               "components": components([(word[2], word[3]) for word in words])})
            if text[cursor:].strip() or not groups:
                raise ValueError("unmatched trailing text or no lexical groups")
            cases.append({"id": f"{source}:{split}:{identifier}", "language": language, "suite": "ud",
                          "source": source, "split": split, "text": text, "complete": True, "groups": groups})
        except (KeyError, ValueError) as error:
            rejected.append({"id": identifier, "reason": str(error)})
    validate_cases(cases)
    return cases, rejected


def sample_cases(cases, budget):
    result, words = [], 0
    for case in sorted(cases, key=lambda row: hashlib.sha256(row["id"].encode()).hexdigest()):
        if words >= budget:
            break
        result.append(case)
        words += sum(len(group["components"]) for group in case["groups"])
    return result


def validate_cases(cases):
    seen = set()
    for case in cases:
        if case["id"] in seen:
            raise ValueError("Duplicate case ID: " + case["id"])
        seen.add(case["id"])
        if case["language"] not in {"es", "pt", "en", "zh"} or case["split"] not in {"dev", "test"}:
            raise ValueError("Invalid language/split: " + case["id"])
        raw = case["text"].encode("utf-16-le")
        previous = 0
        for group in case["groups"]:
            if not (previous <= group["from"] < group["to"] <= len(raw) // 2):
                raise ValueError("Overlapping or invalid source offsets: " + case["id"])
            if raw[group["from"] * 2:group["to"] * 2].decode("utf-16-le") != group["form"]:
                raise ValueError("Reference text/offset mismatch: " + case["id"])
            if not group["components"] or any(not word["lemma"] or not word["upos"] for word in group["components"]):
                raise ValueError("Empty answer: " + case["id"])
            previous = group["to"]


def inventory(groups):
    return {normalized(word["lemma"]) for group in groups for word in group["components"] if word["upos"] != "PROPN"}


def score_case(case, prediction):
    expected = case["groups"]
    assigned = [[] for _ in expected]
    unaligned = []
    for token in prediction["groups"]:
        hits = [index for index, group in enumerate(expected) if token["from"] < group["to"] and token["to"] > group["from"]]
        if len(hits) == 1 and token["from"] >= expected[hits[0]]["from"] and token["to"] <= expected[hits[0]]["to"]:
            assigned[hits[0]].append(token)
        elif hits or case["complete"]:
            unaligned.append(token)
    correct, mismatches, merge_pairs, false_names, missed_names = 0, [], [], 0, 0
    name_errors = []
    for group, tokens in zip(expected, assigned):
        gold = sorted(word["lemma"] for word in group["components"])
        actual = sorted(normalized(word["lemma"]) for token in tokens for word in token["components"])
        # Every lexical character must be covered; a plausible lemma on half a word is not a correct match.
        covered = {index for token in tokens for index in range(token["from"], token["to"])}
        needed, position = set(), group["from"]
        for char in group["form"]:
            width = utf16(char)
            if char.isalpha() or unicodedata.category(char).startswith("M"):
                needed.update(range(position, position + width))
            position += width
        matches = gold == actual and needed.issubset(covered)
        gold_name = all(word["upos"] == "PROPN" for word in group["components"])
        predicted_words = [word for token in tokens for word in token["components"]]
        actual_name = bool(predicted_words) and all(word.get("excluded", word["upos"] == "PROPN") for word in predicted_words)
        false_names += int(actual_name and not gold_name)
        missed_names += int(gold_name and not actual_name)
        if gold_name != actual_name:
            name_errors.append({"form": group["form"], "from": group["from"], "to": group["to"], "expected_excluded": gold_name, "predicted_excluded": actual_name})
        correct += int(matches)
        if not matches:
            mismatches.append({"form": group["form"], "from": group["from"], "to": group["to"], "expected": gold, "predicted": actual})
        if len(gold) == len(actual) == 1 and group["components"][0]["upos"] != "PROPN":
            merge_pairs.append([actual[0], gold[0]])
    gold_inventory = inventory(expected) if case["complete"] else None
    actual_inventory = set(prediction["inventory"]) if gold_inventory is not None else None
    return {"id": case["id"], "language": case["language"], "suite": case["suite"], "split": case["split"],
            "text": case["text"], "groups": len(expected), "correct": correct, "mismatches": mismatches,
            "unaligned": len(unaligned), "milliseconds": prediction.get("milliseconds", 0),
            "alignment_errors": unaligned, "name_errors": name_errors,
            "false_name_exclusions": false_names, "missed_names": missed_names,
            "gold_inventory": sorted(gold_inventory) if gold_inventory is not None else None,
            "predicted_inventory": sorted(actual_inventory) if actual_inventory is not None else None,
            "extra": sorted(actual_inventory - gold_inventory) if gold_inventory is not None else [],
            "missing": sorted(gold_inventory - actual_inventory) if gold_inventory is not None else [], "merge_pairs": merge_pairs}


def summarize(rows):
    groups = sum(row["groups"] for row in rows)
    gold, predicted, aliases = set(), set(), defaultdict(set)
    complete = [row for row in rows if row["gold_inventory"] is not None]
    for row in rows:
        if row["gold_inventory"] is not None:
            gold.update(row["gold_inventory"]); predicted.update(row["predicted_inventory"])
        for actual, expected in row["merge_pairs"]:
            aliases[actual].add(expected)
    shared = len(gold & predicted)
    precision = shared / len(predicted) if predicted else (1 if not gold else 0)
    recall = shared / len(gold) if gold else 1
    return {"cases": len(rows), "source_words": groups, "correct": sum(row["correct"] for row in rows),
            "accuracy": sum(row["correct"] for row in rows) / groups if groups else None,
            "inventory_precision": precision if complete else None, "inventory_recall": recall if complete else None,
            "inventory_f1": 2 * shared / (len(gold) + len(predicted)) if complete and gold | predicted else (1 if complete else None),
            "false_entries": sum(len(row["extra"]) for row in rows) if complete else None,
            "missed_entries": sum(len(row["missing"]) for row in rows) if complete else None,
            "unaligned_spans": sum(row["unaligned"] for row in rows),
            "false_name_exclusions": sum(row["false_name_exclusions"] for row in rows), "missed_names": sum(row["missed_names"] for row in rows),
            "milliseconds": sum(row["milliseconds"] for row in rows),
            "potential_merges": {key: sorted(values) for key, values in sorted(aliases.items()) if len(values) > 1}}


def load_json(path):
    with open(path, encoding="utf-8") as file:
        return json.load(file)
