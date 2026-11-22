"""Select grammatical readings and decompose clitics using tagged paradigms."""
import itertools

from spanish_lexicon import key, plain, readings


PRONOUN_LEMMAS = {"me": "yo", "nos": "yo", "te": "tú", "os": "tú",
                  "se": "él", "lo": "él", "la": "él", "los": "él", "las": "él", "le": "él", "les": "él"}
CLITIC_GROUPS = [("se",), ("te", "os"), ("me", "nos"), ("lo", "la", "los", "las", "le", "les")]
CLITICS = sorted([parts for size in (1, 2, 3) for groups in itertools.combinations(CLITIC_GROUPS, size)
                  for parts in itertools.product(*groups)], key=lambda parts: -sum(map(len, parts)))


def features(token):
    return dict(item.split("=", 1) for item in str(token.morph).split("|") if "=" in item)


def main_lemma(token):
    # Combined model output is evidence for the verb, never a combined inventory entry.
    return key(token.lemma_ or token.text).split()[0]


def clause_boundary(token):
    for part in reversed(token.doc[max(0, token.i - 3):token.i]):
        if part.pos_ == "ADV":
            continue
        return getattr(part, "is_punct", False) or part.pos_ in {"CCONJ", "SCONJ"}
    return token.i <= 3


def unaccented_stress(value):
    """Locate ordinary written stress for the unaccented name/clitic safeguard."""
    value = key(value)
    nuclei = []
    for index, char in enumerate(value):
        if char not in "aeiouü":
            continue
        joins = nuclei and nuclei[-1][-1][0] == index - 1 and not (
            char in "aeo" and any(vowel in "aeo" for _, vowel in nuclei[-1]))
        if joins:
            nuclei[-1].append((index, char))
        else:
            nuclei.append([(index, char)])
    if not nuclei:
        return None
    nucleus = nuclei[-2] if len(nuclei) > 1 and value[-1] in "aeiouüns" else nuclei[-1]
    return next((index for index, char in nucleus if char in "aeo"), nucleus[-1][0])


def choose(token, candidates, source="Spanish tagged morphology"):
    if not candidates:
        return None
    lemmas = sorted({item["lemma"] for item in candidates})
    model = main_lemma(token)
    resolved = False
    if set(lemmas) == {"ir", "ser"}:
        before = [key(part.text) for part in token.doc[max(0, token.i - 4):token.i]]
        after = list(token.doc[token.i + 1:token.i + 3])
        if after and (after[0].pos_ == "ADJ" or "VerbForm=Part" in str(after[0].morph)):
            model, resolved = "ser", True
        elif before and before[-1] in {"adonde", "adónde"}:
            model, resolved = "ir", True
        elif before[-2:] in [["sea", "quien"], ["sea", "como"]] or before[-3:] == ["sea", "lo", "que"]:
            model, resolved = "ser", True
    attrs = features(token)
    mood = {"Inf": "N", "Ger": "G", "Part": "P"}.get(attrs.get("VerbForm")) or {"Ind": "I", "Sub": "S", "Imp": "M"}.get(attrs.get("Mood"))
    tense = {"Pres": "P", "Past": "S", "Imp": "I", "Fut": "F"}.get(attrs.get("Tense"))
    def score(item):
        return (8 * (item["lemma"] == model), 2 * bool(mood and item.get("mood") == mood)
                + bool(tense and item.get("tense") == tense)
                + bool(attrs.get("Person") and item.get("person") == attrs["Person"]))
    chosen = max(candidates, key=score)
    result = {"lemma": chosen["lemma"], "pos": token.pos_ if token.pos_ in {"VERB", "AUX"} and chosen["pos"] == "VERB" else chosen["pos"],
              "lemmaSource": source, "morphology": chosen["tag"]}
    if key(token.lemma_ or token.text) != chosen["lemma"]:
        result["modelLemma"] = key(token.lemma_ or token.text)
    if len(lemmas) > 1:
        result.update(lemmaCandidates=lemmas, lemmaUncertain=not resolved)
    return result


def enclitic(token):
    word = key(token.text)
    if not word.endswith(tuple(PRONOUN_LEMMAS)):
        return None
    whole = readings(word)
    preferred = "VERB" if token.pos_ == "AUX" else token.pos_
    if any(item["pos"] == preferred for item in whole):
        return None
    start = clause_boundary(token)
    stressed = word != plain(word)
    model_verbal = token.pos_ in {"VERB", "AUX"}
    options = []
    for parts in CLITICS:
        suffix = "".join(parts)
        if not word.endswith(suffix) or len(word) <= len(suffix) + 1:
            continue
        stem = word[:-len(suffix)]
        variants = [stem]
        # These are grammatical alternations, applied to every attested paradigm.
        if parts[0] in {"nos", "se"} and plain(stem).endswith("mo"):
            variants.append(stem + "s")
        if parts[0] == "os" and plain(stem).endswith(("a", "e", "i")):
            variants.append(stem + "d")
        for variant in variants:
            for item in readings(variant, folded=True):
                mood = item["mood"]
                modern = mood in {"N", "G", "M"}
                historical = not modern and mood != "P" and (model_verbal or stressed)
                if not (modern or historical):
                    continue
                named = token.pos_ == "PROPN" or getattr(token, "ent_type_", "") in {"PER", "PERSON", "LOC", "GPE"}
                if named and not stressed and not (start and mood == "M" and unaccented_stress(variant) == unaccented_stress(word)):
                    continue
                if not model_verbal and not (mood in {"N", "G"} or stressed or start and mood == "M"):
                    continue
                options.append((item, parts, 3 if mood in {"N", "G"} else 2 if mood == "M" else 1))
    if not options:
        return None
    best = max(item[2] for item in options)
    options = [item for item in options if item[2] == best]
    selected = choose(token, [item[0] for item in options], "Spanish verb and attached pronouns")
    reading, parts, _ = next(item for item in options if item[0]["lemma"] == selected["lemma"])
    end = len(token.text) - sum(map(len, parts))
    components = [{"lemma": selected["lemma"], "pos": "VERB", "from": 0, "to": end}]
    for part in parts:
        components.append({"lemma": PRONOUN_LEMMAS[part], "pos": "PRON", "word": part, "from": end, "to": end + len(part)})
        end += len(part)
    return {**selected, "pos": "VERB", "components": components}


def correction(token):
    if token.pos_ == "NUM":
        word = key(token.text)
        # Recover a verified alphabetical finite verb, while preserving digits,
        # spelled numbers and Roman numerals such as VI, which overlaps with ver.
        if not word.isalpha() or all(char in "ivxlcdm" for char in word):
            return None
        whole = readings(word)
        finite = [item for item in whole if item.get("mood") == "I" and item.get("tense") == "S"
                  or item.get("mood") == "S" and item.get("tense") == "F"]
        return choose(token, finite) if finite and all(item["pos"] == "VERB" for item in whole) else None
    if token.pos_ not in {"VERB", "AUX", "NOUN", "ADJ", "PROPN"}:
        return None
    if token.pos_ == "PROPN":
        whole = readings(token.text)
        # Lowercase finite forms can be false names in the small contextual model.
        # Competing noun readings and capitalized names remain protected.
        finite = [item for item in whole if item.get("mood") == "I" and item.get("tense") == "S"
                  or item.get("mood") == "S" and item.get("tense") == "F"]
        if token.text.islower() and finite and not any(item["pos"] == "NOUN" for item in whole):
            return choose(token, finite)
        return enclitic(token)
    candidates = readings(token.text)
    preferred = "VERB" if token.pos_ == "AUX" else token.pos_
    if token.pos_ == "ADJ":
        participles = [item for item in candidates if item.get("mood") == "P"]
        if participles:
            return choose(token, participles, "Spanish participle grouped with its verb")
    matching = [item for item in candidates if item["pos"] == preferred]
    if matching:
        return choose(token, matching)
    split = enclitic(token)
    if split:
        return split
    if token.pos_ in {"NOUN", "ADJ"}:
        # Recover a mistagged word only when the dictionary has no competing noun.
        if token.pos_ == "NOUN":
            adjectives = [item for item in candidates if item["pos"] == "ADJ"]
            if adjectives:
                return choose(token, adjectives)
        verbal = [item for item in candidates if item["pos"] == "VERB" and (
            item.get("mood") in {"N", "G"} or item.get("mood") == "I" and item.get("tense") == "S"
            or item.get("mood") == "S" and item.get("tense") == "F")]
        if verbal:
            return choose(token, verbal)
    return None
