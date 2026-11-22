# Spanish reader vocabulary normalization

The analyzer sometimes returned combined headwords such as `achicar yo` and `agregar él`, or left `-ándome` and stacked pronouns unparsed. It now keeps the base verb as the main lemma and attaches separate grammatical components with their original UTF-16 source positions. Inventory, reading exposures, read-book contributions, recommendations and below-threshold lists all use these components. Original source words remain intact for hover and audio matching.

Examples: `achicarme / achicándome → achicar + yo`; `agregarlo → agregar + él`; `aproximársele → aproximar + él + él`. The two occurrences of `él` represent different pronouns, so they have separate exposure positions while sharing one vocabulary entry. This retains the existing singular-person pronoun convention. The reader-reported `aproximárse` spelling also recovers the attested base without changing the source text.

## Grouping convention

- Attested verb forms are recovered from the installed spaCy lookup dictionary. Preterite recovery checks attested conjugation paradigms rather than assuming every similar suffix is a verb. `oyó` and `oyeron` retain the accent in `oír`.
- Adjective gender/number inflections and a conservative list of common animate noun pairs share a headword, including `adulto/adulta`. Other noun readings are preserved. The raw lookup alone would incorrectly turn nouns such as `música` into `músico` or `línea` into `líneo`.
- Contextually identified adjectival participles are grouped with their attested verb, including `almizclada → almizclar`. The original model lemma remains in token metadata. This is an intentional reader-vocabulary convention; a strict morphological annotation can treat that adjective's lemma as `almizclado`.
- Noun/name controls include `tomate`, `modelo`, `regalo`, `vestido`, `bolsa/bolso`, `huerta/huerto` and proper names. Missing dictionary entries and contextual tagging errors can still require review.

Primary grammar references: RAE's [clitic placement, order and spelling](https://www.rae.es/dpd/pronombres%20personales%20%C3%A1tonos), [conjugation paradigms](https://www.rae.es/dpd/ayuda/modelos-de-conjugacion-verbal), [gender variation and distinct noun pairs](https://www.rae.es/gtg/g%C3%A9nero), and [adulto/adulta](https://dle.rae.es/adulto). These references guide the rules, rather than providing independent adjudication of the test sentences.

## Validation

The new key has 49 assistant-authored cases with 67 explicitly labelled targets. It was used during implementation and is regression evidence, not an untouched holdout evaluation. A before/after run calls the actual analyzer with spaCy 3.8.11 and `es_core_news_sm` 3.8.0. Full numeric summaries and source hashes are in [spanish-forms-validation.json](spanish-forms-validation.json).

The new normalization targets improve from **27/67 to 65/67** exact source-word matches. The remaining two targets are pre-existing context/POS errors: *frías* is treated as a noun in one sentence, and *consuelo* as a verb in another. The original 62 future-subjunctive targets continue to pass. The original Spanish challenge test improves from **78/86 to 81/86**.

Published AnCora test agreement changes from **99.62% to 98.73%**, and inventory F1 from **99.12% to 97.51%**. Many new disagreements are expected under the requested grouping: the reference uses adjective lemmas such as `diseñado`, while Langy's reader inventory groups them with `diseñar`; some gender-pair references remain feminine. These figures use the unchanged reference key, so they should not be interpreted as an improvement in strict UD lemmatization or hidden by changing that key. Novel accuracy and sense disambiguation remain separate questions.

The Python checks exercise pronoun order, missing imperative letters, accents, malformed/unknown stems, noun/name preservation and ambiguous verb paradigms. App tests verify distinct pronoun occurrences, retry-safe exposure counts, completion/reanalysis, replacement of legacy combined entries, migration and actual hover lookup. A single upgrade refreshes existing Spanish books and saved exposure history. Files, bookmarks and audio are retained.

```bash
bash scripts/benchmark-lemmas.sh --languages es --suite forms --split all
```
