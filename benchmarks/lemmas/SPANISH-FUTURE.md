# Spanish future-subjunctive correction

This record describes the first future-subjunctive correction. Later pronoun, gender and participle grouping has its own [validation record](SPANISH-FORMS.md), including its differences from published lemma conventions.

The small Spanish model invented headwords such as `hubierir`, `tuvierir` and `hicierir` for future subjunctives. The production correction derives these forms from attested third-person-plural preterites in the already installed `spacy-lookups-data` 1.0.5 dictionary. It preserves accents, original source spans and book text. No additional model or API is required.

RAE describes the [simple future subjunctive](https://www.rae.es/gtg/futuro-simple-de-subjuntivo), [compound future subjunctive](https://www.rae.es/gtg/futuro-compuesto-de-subjuntivo) and [conjugation paradigms](https://www.rae.es/dpd/ayuda/modelos-de-conjugacion-verbal). The regression examples include literary, formulaic and legal constructions that the existing model often misanalysed in these checks.

## Measured regression checks

Baseline commit: `5bd00055083a922c87e3e451d5ab60230ece2879`. Both runs called the real production analysis function with spaCy 3.8.11 and `es_core_news_sm` 3.8.0 in separate CPU processes. Before run: `20261122T183550Z-3a3970`; after run: `20261122T183550Z-44624f`.

| Source | Labelled split | Annotated source spans | Before exact matches | After exact matches |
|---|---|---:|---:|---:|
| New future-subjunctive regressions | dev | 13 | 1/13 | 13/13 |
| New future-subjunctive regressions | test | 49 | 6/49 | 49/49 |
| Original Spanish challenge | dev | 21 | 18/21 | 18/21 |
| Original Spanish challenge | test | 86 | 78/86 | 78/86 |
| Published AnCora sample | dev | 398 | 393/398 | 393/398 |
| Published AnCora sample | test | 787 | 784/787 | 784/787 |

All scoring, alignment, name-filter and inventory outputs were unchanged for the **89 original/published Spanish cases**, rather than only their aggregate accuracy. The published test inventory F1 remains 99.12%. Numeric results, model identities and source/key hashes are recorded in [spanish-future-validation.json](spanish-future-validation.json).

The new 60-case, 62-target key was authored during this fix, without independent human adjudication. Its dev/test labels organize the cases; they do not make this an untouched holdout experiment. The result establishes that the listed regressions pass, rather than 100% accuracy on arbitrary Spanish. The historical multilingual pilot remains in [VALIDATION.md](VALIDATION.md).

## Ambiguities and scope

- Noun readings such as *los cantares* and *sus pesares* retain contextual analysis. Recovery of a form mistagged as a noun requires a narrow clause frame; proper names are preserved.
- *Fuere* can belong to *ir* or *ser*. Clear directional, copular and passive constructions are resolved conservatively; other readings show both candidates on hover while retaining one provisional inventory entry.
- *Equipare* can be a future form of *equipar* or a present subjunctive of *equiparar*. Attested alternate infinitives are retained and marked ambiguous instead of forcing a future interpretation. Unit tests cover this collision.
- Future-indicative accent differences, unknown endings and missing dictionary paradigms are not guessed by stripping suffixes. Historical spelling variants and difficult context can still need review.

The correction adds a cached dictionary index; peak worker RSS in this run rose from about 318 MiB to 431 MiB, including Python/model load. Warmed inference stayed comparable on these small passages. These are CPU benchmark measurements, rather than a live-reader latency guarantee.

The reader queues existing Spanish and detected/declared mixed-Spanish analyses once after upgrade. Completion rebuilds saved vocabulary exposure counts using corrected lemmas. Original chapters and audio records are retained, and no paid inference is used for the correction.

```bash
bash scripts/benchmark-lemmas.sh --languages es --suite future --split all
```
