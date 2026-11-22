"""Spanish tagged morphology with a conservative fallback for missing entries.

Dictionary readings supply POS, gender and full verb paradigms. The fallback
uses attested lookup forms and never invents a verb from an arbitrary suffix.
"""
import functools
import gzip
import json
from pathlib import Path
import unicodedata
from spanish_dictionary import correction as dictionary_correction, PRONOUN_LEMMAS, CLITICS


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


def build_past_index(lookup):
    index = {}
    for form, lemma in lookup.items():
        if not form.endswith("ron") or not lemma.endswith(("ar", "er", "ir", "ír")):
            continue
        regular = lemma[:-2]
        endings = ("é", "aste", "ó", "amos", "asteis", "aron") if lemma.endswith("ar") else (
            "í", "iste", "ió", "imos", "isteis", "ieron", "íste", "ímos", "ísteis")
        forms = {regular + ending for ending in endings} | {form}
        if form.endswith("aron"):
            forms.update(form[:-4] + ending for ending in ("é", "aste", "ó", "amos", "asteis", "aron"))
        elif form.endswith("ieron"):
            stem = form[:-5]
            forms.update(stem + ending for ending in ("í", "iste", "ió", "imos", "isteis", "ieron"))
            if stem != regular:
                forms.update(stem + ending for ending in ("e", "o", "i", "io"))
        elif form.endswith("eron"):
            forms.update(form[:-4] + ending for ending in ("e", "iste", "o", "imos", "isteis", "eron", "i", "ó"))
        for past in forms:
            if lookup.get(past) == lemma:
                index[past] = lemma
    return index


def build_conjugation_data(lookup):
    future = build_future_index(lookup)
    alternatives = {form: key(lookup[form]) for form, lemmas in future.items()
                    if form in lookup and key(lookup[form]) not in lemmas}
    participles = {key(form): key(lemma) for form, lemma in lookup.items()
                   if lemma.endswith(("ar", "er", "ir", "ír")) and
                   form.endswith(("ado", "ada", "ados", "adas", "ido", "ida", "idos", "idas",
                                  "to", "ta", "tos", "tas", "so", "sa", "sos", "sas", "cho", "cha", "chos", "chas"))}
    verbs = {key(form): key(lemma) for form, lemma in lookup.items() if lemma.endswith(("ar", "er", "ir", "ír"))}
    infinitives = set(verbs.values())
    nouns = {key(lemma) for lemma in lookup.values() if not lemma.endswith(("ar", "er", "ir", "ír"))}
    gender = {key(form): key(lemma) for form, lemma in lookup.items()
              if lemma.endswith("o") and form in {lemma[:-1] + "a", lemma[:-1] + "as", lemma + "s"}}
    return future, alternatives, participles, verbs, infinitives, nouns, gender, build_past_index(lookup)


@functools.lru_cache(maxsize=1)
def conjugation_data():
    import spacy_lookups_data
    path = Path(spacy_lookups_data.es["lemma_lookup"])
    opener = open
    if not path.exists():
        path = path.with_suffix(path.suffix + ".gz"); opener = gzip.open
    with opener(path, "rt", encoding="utf-8") as file:
        return build_conjugation_data(json.load(file))


def future_index():
    return conjugation_data()[0]


def alternative_index():
    return conjugation_data()[1]


def participle_index():
    return conjugation_data()[2]


def verb_data():
    return conjugation_data()[3:6]


def gender_index():
    return conjugation_data()[6]


def past_index():
    return conjugation_data()[7]


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


ACUTES = str.maketrans("áéíóú", "aeiou")


def enclitic_correction(token):
    word = key(token.text)
    if not word.endswith(tuple(PRONOUN_LEMMAS)):
        return None
    if token.pos_ == "PROPN" and word == word.translate(ACUTES):
        return None
    verbs, infinitives, nouns = verb_data()
    lemma = key(token.lemma_ or token.text)
    # An attested whole-word reading (regalo, camelo, modelo) takes precedence.
    if word in verbs and " " not in lemma:
        return None
    if token.pos_ not in {"VERB", "AUX"} and (word in nouns or lemma in nouns):
        return None
    for parts in CLITICS:
        suffix = "".join(parts)
        if not word.endswith(suffix) or len(word) <= len(suffix) + 1:
            continue
        stem = word[:-len(suffix)]
        plain = stem.translate(ACUTES)
        variants = [stem, plain]
        # Exhortative -mos loses s before nos/se; vosotros loses d before os.
        if parts[0] in {"nos", "se"} and plain.endswith("mo"):
            variants.append(plain + "s")
        if parts[0] == "os" and plain.endswith(("a", "e", "i")):
            variants.append(plain + "d")
        for index, char in enumerate(plain):
            if char in "aeiou":
                variants.append(plain[:index] + char.translate(str.maketrans("aeiou", "áéíóú")) + plain[index + 1:])
        for base in dict.fromkeys(variants):
            headword = base if base in infinitives else verbs.get(base)
            if not headword:
                continue
            nonfinite = base in infinitives or base.endswith(("ando", "iendo", "yendo"))
            clause_start = token.i == 0 or getattr(token.doc[token.i - 1], "is_punct", False)
            imperative = clause_start and base.endswith(("a", "e", "á", "é", "ad", "ed", "id"))
            # Recover misclassified forms only with strong spelling evidence.
            if token.pos_ not in {"VERB", "AUX"} and not nonfinite and not (
                token.pos_ in {"NOUN", "ADJ", "PROPN"} and any(char in word for char in "áéíóú")
            ) and not (token.pos_ in {"NOUN", "PROPN"} and imperative):
                continue
            if token.pos_ == "PROPN" and not any(char in word for char in "áéíóú") and not imperative:
                continue
            # Suffixes are ASCII, so their source positions survive NFC normalization.
            end = len(token.text) - len(suffix)
            components = [{"lemma": headword, "pos": "VERB", "from": 0, "to": end}]
            offset = end
            for part in parts:
                components.append({"lemma": PRONOUN_LEMMAS[part], "pos": "PRON", "word": part,
                                   "from": offset, "to": offset + len(part)})
                offset += len(part)
            return {"lemma": headword, "components": components, "pos": "VERB", "lemmaSource": "Spanish verb and attached pronouns"}
    return None


def spanish_correction(token):
    tagged = dictionary_correction(token)
    if tagged:
        return tagged
    if token.pos_ not in {"VERB", "AUX", "NOUN", "ADJ", "PROPN"}:
        return None
    correction = spanish_future_correction(token) or enclitic_correction(token)
    if correction:
        return correction
    word = key(token.text)
    lemma = key(token.lemma_ or token.text)
    if token.pos_ in {"VERB", "AUX"}:
        verbs, infinitives, _ = verb_data()
        attested = verbs.get(word)
        if attested:
            # The untagged fallback cannot disambiguate two attested infinitives.
            if lemma in infinitives and lemma != attested:
                return {"lemma": lemma, "lemmaCandidates": sorted({lemma, attested}),
                        "lemmaUncertain": True, "lemmaSource": "Spanish verb paradigm"}
            past = "Tense=Past" in str(token.morph) or word.endswith(("é", "aste", "ó", "asteis", "aron", "í", "iste", "ió", "isteis", "ieron"))
            if lemma not in infinitives or past:
                return {"lemma": attested, "lemmaSource": "Spanish verb paradigm"}
    if token.pos_ in {"NOUN", "ADJ"}:
        verbs, _, nouns = verb_data()
        if word not in nouns and lemma not in nouns and word in past_index():
            return {"lemma": past_index()[word], "pos": "VERB", "lemmaSource": "Spanish preterite paradigm"}
    if token.pos_ == "ADJ" and "VerbForm=Part" in str(token.morph):
        attested = participle_index().get(word)
        if attested:
            return {"lemma": attested, "modelLemma": lemma, "lemmaSource": "Spanish participle grouped with its verb"}
    if token.pos_ == "ADJ":
        attested = gender_index().get(word)
        if attested:
            return {"lemma": attested, "modelLemma": lemma, "lemmaSource": "Spanish gender inflection"}
    return None
