"""Conservative future-subjunctive recovery from attested Spanish verb paradigms.

The future subjunctive uses the third-person-plural preterite stem without -ron.
Use the installed lookup lexicon to establish the verb; never invent an infinitive
by removing a suffix from an arbitrary reader word.
"""
import functools
import gzip
import json
from pathlib import Path
import unicodedata


def key(text):
    return unicodedata.normalize("NFC", text).casefold()


def build_future_index(lookup):
    index = {}
    accents = str.maketrans("aeiou", "áéíóú")
    for form, lemma in lookup.items():
        form, lemma = key(form), key(lemma)
        if not form.endswith("ron") or not lemma.endswith(("ar", "er", "ir", "ír")):
            continue
        stem = form[:-3]
        if not stem or stem[-1] not in "aeiou":
            continue
        forms = [stem + ending for ending in ("re", "res", "reis", "ren")]
        forms.append(stem[:-1] + stem[-1].translate(accents) + "remos")
        lemmas = {lemma, "ir", "ser"} if form == "fueron" else {lemma}
        for future in forms:
            index.setdefault(future, set()).update(lemmas)
    return {form: tuple(sorted(lemmas)) for form, lemmas in index.items()}


@functools.lru_cache(maxsize=1)
def conjugation_data():
    import spacy_lookups_data
    path = Path(spacy_lookups_data.es["lemma_lookup"])
    opener = open
    if not path.exists():
        path = path.with_suffix(path.suffix + ".gz"); opener = gzip.open
    with opener(path, "rt", encoding="utf-8") as file:
        lookup = json.load(file)
    future = build_future_index(lookup)
    alternatives = {form: key(lookup[form]) for form, lemmas in future.items()
                    if form in lookup and key(lookup[form]) not in lemmas}
    participles = {key(form): key(lemma) for form, lemma in lookup.items()
                   if lemma.endswith(("ar", "er", "ir", "ír")) and
                   form.endswith(("ado", "ada", "ados", "adas", "ido", "ida", "idos", "idas",
                                  "to", "ta", "tos", "tas", "so", "sa", "sos", "sas", "cho", "cha", "chos", "chas"))}
    return future, alternatives, participles


def future_index():
    return conjugation_data()[0]


def alternative_index():
    return conjugation_data()[1]


def participle_index():
    return conjugation_data()[2]


def clause_start(token):
    # Only personal pronouns/clitics may intervene; a determiner or noun blocks recovery.
    intervening = {"yo", "tú", "él", "ella", "usted", "nosotros", "nosotras", "vosotros", "vosotras",
                   "ellos", "ellas", "ustedes", "vos", "me", "te", "se", "nos", "os", "lo", "la", "los", "las", "le", "les", "no"}
    for part in reversed(token.doc[max(0, token.i - 4):token.i]):
        word = key(part.text)
        if word in {"si", "quien", "quienes", "adonde", "adónde"}:
            return True
        if word not in intervening:
            return False
    return False


def future_subjunctive(token):
    word = key(token.text)
    if not word.endswith(("re", "res", "remos", "reis", "ren")):
        return None
    candidates = future_index().get(word)
    if not candidates:
        return None
    lemma = key(token.lemma_ or token.text)
    alternative = alternative_index().get(word)
    # The small model sometimes labels rare finite forms as nouns. Recover only
    # in a narrow clause frame, while retaining real nouns such as cantares/pesares.
    if token.pos_ not in {"VERB", "AUX"} and not (
        token.pos_ == "NOUN" and lemma not in (*candidates, alternative) and clause_start(token)
    ):
        return None
    # Equipare can also be present subjunctive of equiparar. Preserve an attested
    # alternative instead of forcing every matching ending into the future tense.
    mixed_tenses = bool(alternative and alternative.endswith(("ar", "er", "ir", "ír")))
    if mixed_tenses:
        candidates = tuple(sorted({*candidates, alternative}))
    certain = len(candidates) == 1
    if certain:
        lemma = candidates[0]
    elif set(candidates) == {"ir", "ser"}:
        before = [key(part.text) for part in token.doc[max(0, token.i - 6):token.i]]
        after = [part for part in token.doc[token.i + 1:token.i + 5] if not part.is_space]
        # Narrow, explicit constructions; keep other ser/ir readings marked ambiguous.
        if before and before[-1] in {"adonde", "adónde"} and not (after and after[0].pos_ == "ADJ"):
            lemma, certain = "ir", True
        elif after and (after[0].pos_ == "ADJ" or "VerbForm=Part" in str(after[0].morph)):
            lemma, certain = "ser", True
        elif "sea" in before and any(part in {"quien", "quienes", "cual", "cuales", "como", "que"} for part in before):
            lemma, certain = "ser", True
        elif lemma not in candidates:
            # A valid default avoids an invented headword, while the alternative remains explicit.
            lemma = "ser"
    elif lemma not in candidates:
        return None
    return {"lemma": lemma, "lemmaCandidates": list(candidates), "lemmaUncertain": not certain,
            "lemmaSource": "Spanish conjugation" if mixed_tenses else "Spanish future subjunctive",
            "morphology": "" if mixed_tenses else "Mood=Sub|Tense=Fut",
            "pos": token.pos_ if token.pos_ in {"VERB", "AUX"} else "VERB"}


def spanish_future_correction(token):
    correction = future_subjunctive(token)
    if correction:
        return correction
    # A participle in hubiere + participle is verbal even when mistagged as an adjective.
    if token.i and "VerbForm=Part" in str(token.morph) and token.pos_ != "PROPN":
        auxiliary = future_subjunctive(token.doc[token.i - 1])
        if auxiliary and auxiliary["lemma"] == "haber":
            lemma = participle_index().get(key(token.text))
            if lemma:
                return {"lemma": lemma, "lemmaCandidates": [lemma], "lemmaUncertain": False,
                        "lemmaSource": "Spanish compound future subjunctive", "morphology": "VerbForm=Part", "pos": "VERB"}
    return None
