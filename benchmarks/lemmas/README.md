# Lemma benchmark

The benchmark has been exercised with the real pinned models. See [the recorded pilot](VALIDATION.md) for measured results and the limits of that comparison.

Run from the checkout on your server:

```bash
cd ~/Langy-Reader &&
git pull --ff-only &&
bash scripts/benchmark-lemmas.sh
```

The first run builds a separate CPU-only image and downloads public spaCy/Stanza models and pinned reference data. Subsequent builds reuse those layers. Docker Compose is required; the wrapper uses `sudo docker` when necessary. Downloads require Internet access during the image build. Evaluation runs with networking disabled and uses no LLM, paid API, account or API key.

The benchmark is a standalone Compose project. It mounts only `benchmark-results`, does not load your reader's `.env`, and does not start, stop, upgrade or write to your running reader, books, audio or vocabulary database. It compares the checked-out `language/app.py` against a Stanza candidate. Production analysis remains a separate decision after reviewing the evidence.

## The answer key

There are five separately reported sources:

1. **Published references:** fixed, checksum-verified development/test files from Universal Dependencies **r2.15**, using Spanish AnCora, Portuguese Bosque and English EWT. `sources.json` pins repository commits and file SHA-256 values. `prepare_corpora.py` constructs the answer key directly from the existing annotations, without asking either candidate model or an LLM to label them. It selects whole sentences by SHA-256 ordering of sentence IDs, with budgets of 400 lexical components per language for development and 800 for test. Original annotations, multiword-token parents, source text, contributor/license metadata and excluded alignment cases are retained. The upstream annotations have different histories: AnCora lemmas were converted from manual annotation; Bosque annotations were converted with corrections; EWT lemmas were generated with corrections. These are published reference annotations, not a promise that every entry is infallible.
2. **Original challenge key:** `challenge.json` contains **105 cases and 299 explicitly annotated targets**, including Spanish/Portuguese/English ambiguities, regional nouns, inflections, contractions, attached pronouns, proper names and Mandarin characters. The sentences and expected answers were authored and reviewed by the assistant; they have not been independently adjudicated by a human. The expected answers are explicit and never generated from the model under test. These are targeted checks, so unannotated context is not scored and full vocabulary-inventory statistics are omitted for them. Chinese character checks have complete character annotations and are reported separately from lemma results.
3. **Spanish future-subjunctive regressions:** `spanish-future.json` adds **60 cases and 62 annotated targets**, reported separately as `spanish-future`. These assistant-authored checks cover regular/irregular paradigms, compound auxiliaries, clear *ser/ir* constructions and noun lookalikes. They were used while implementing the correction and are regression evidence, rather than untouched holdout data. See [the before/after comparison](SPANISH-FUTURE.md). The original challenge and published keys remain unchanged.
4. **Spanish reader normalization:** `spanish-forms.json` adds **49 cases and 67 targets**, reported as `spanish-forms`. These assistant-authored regressions cover attached pronouns, gerunds, preterites, gender pairs and participles, with noun/name controls. Expected participle and animate-gender entries follow the requested learner grouping, which can differ from the published reference's lemma convention. See [the measured results and remaining errors](SPANISH-FORMS.md).
5. **Generalized Spanish morphology:** `spanish-generalization.json` adds **29 cases and 50 targets**, reported as `spanish-generalization`. These assistant-authored regressions cover additional noun/adjective paradigms, new verb roots, complex clitics, irregular participles, ordinals and distinct-noun controls. They were used during development and are not untouched holdout evidence. See [the tagged-dictionary comparison](SPANISH-GENERALIZATION.md).

The default test run has 787 Spanish, 740 Portuguese and 811 English **published source-word spans**, plus 214 original lemma targets, 49 Spanish future-subjunctive targets, 48 Spanish normalization targets, 32 Spanish generalization targets and 27 Mandarin character targets. Component counts differ from source-word counts because a contraction or attached pronoun can represent several grammatical words. `--validate-only` reports exact selected sizes. The full key includes both development and test cases; every run saves its selected, self-contained `answer-key.json` for inspection.

Reference licenses and authors remain associated with their source in the generated key. The original challenge sentences/annotations are offered under CC0-1.0. Published source annotations retain their upstream licenses; see the generated provenance and the source repositories:

- [Spanish AnCora, pinned release](https://github.com/UniversalDependencies/UD_Spanish-AnCora/tree/42b0cec031d661d411bb905cbaf3e508b0dfbf5b)
- [Portuguese Bosque, pinned release](https://github.com/UniversalDependencies/UD_Portuguese-Bosque/tree/4f136acb02344e4f2f5e3d3e9ecc70aab61db62d)
- [English EWT, pinned release](https://github.com/UniversalDependencies/UD_English-EWT/tree/4dc8e10cf32352e11ab2c46e024b19853b91546e)

## What is compared

The baseline calls Langy's actual `analyze()` function, retaining its current spaCy models, spelling normalization, overrides, contractions and named-entity exclusions. The pinned baseline uses spaCy 3.8.11 and the three small 3.8.0 language models. The Stanza candidate uses Stanza 1.15.1, resource release 1.15.0, and the pinned default tokenization, multiword-token, POS and lemma models in `models.json`, including character-language-model POS tagging. Stanza's candidate filters PROPN, but does not include NER; the report explicitly records this difference from Langy's current entity filtering.

Every engine/language runs in a fresh process, with four CPU threads by default. A short unscored warm-up precedes timing and initializes the Spanish conjugation index. Model import/load time, warm-up time and peak whole-worker RSS are recorded separately from warmed inference. Neither uses your chatbot model or GPU. Package versions, model/resource hashes, the exact baseline source hash and reference-key hash accompany the results. Timings and memory reflect the benchmark environment, rather than the live reader's latency or RAM use.

The primary context metric is **source-word lemma accuracy**: the complete multiset of expected lemmas must match at each annotated source span. English `don't` can be predicted as two smaller tokens or one parent token with two components; both can match `do + not`. A merged span crossing two reference words is an alignment error. Every lexical character must be covered, and UTF-16 offsets handle supplementary characters. This is an application-specific comparison, **not the official UD token-level score**.

For complete published sentences we also compare vocabulary inventories, excluding gold PROPN words. The report includes inventory precision/recall/F1, false added entries, missed entries, name-exclusion errors, unaligned spans and potential merges of different reference lemmas. Equal inventory totals alone do not establish accuracy. False/missing entries count `(sentence, lemma)` disagreements; inventory F1 uses the union within each suite/language/split.

Use the error CSV to distinguish a genuine morphological error from a reference convention or debatable annotation. The challenge key documents its citation-form and pronoun conventions; UD source conventions can differ between languages/treebanks. Published treebank passages are mostly web/news text, so this is a useful pilot rather than a calibrated accuracy estimate for novels. Upstream model developers may already have evaluated these published test sets; “test” here refers to the source split, not independently unseen training material. Use fresh, separately annotated literary passages before making broad claims about your own library.

## Reports and options

The summary prints in the terminal. Each run creates `benchmark-results/<UTC timestamp>-<id>/` containing:

- `report.md`: readable comparison.
- `report.json`: metrics, package/model identities, fingerprints and resource measurements.
- `errors.csv`: lemma, alignment, name-exclusion and vocabulary-inventory disagreements with source context.
- `answer-key.json`: the exact selected answers and source/annotation/license metadata.
- Per-engine/language JSON and logs for auditing.

`benchmark-results/LATEST.txt` identifies the newest **completed** comparison. A failed worker leaves its log but does not replace that pointer. Results are ignored by Git and Docker build context.

```bash
# Spanish only, using two CPU threads. The image still includes all three language packs.
bash scripts/benchmark-lemmas.sh --languages es --threads 2

# Use development cases while evaluating proposed fixes.
bash scripts/benchmark-lemmas.sh --split dev

# All original targeted cases, including future-subjunctive regressions.
bash scripts/benchmark-lemmas.sh --suite challenge

# Just the Spanish future-subjunctive regressions, with both labelled splits.
bash scripts/benchmark-lemmas.sh --languages es --suite future --split all

# Just the Spanish attached-pronoun and reader-normalization regressions.
bash scripts/benchmark-lemmas.sh --languages es --suite forms --split all

# Additional Spanish grammatical paradigms and noun controls.
bash scripts/benchmark-lemmas.sh --languages es --suite generalized --split all

# Inspect the built-in challenge key without installing any NLP libraries.
python3 benchmarks/lemmas/benchmark.py --suite challenge --split all --validate-only
```

Do not tune rules against the final comparison and describe the same cases as untouched holdout evidence. Report development, published test and newly collected literary cases separately. No automatic model switch is made by this runner.

The parser/scorer tests use only Python's standard library:

```bash
python3 -m unittest discover -s benchmarks/lemmas -p 'test_*.py'
```

They also run through `npm test`, alongside checks that the wrapper preserves reader settings and invokes only its standalone Compose project. Docker itself must be present to build/run the container; a local virtual environment can run the same Python worker with `--corpora` and `--stanza-models` paths after preparation.
