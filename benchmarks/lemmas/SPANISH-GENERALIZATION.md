# Generalized Spanish grammatical normalization

Spanish now combines the contextual model with 668,422 tagged grammatical readings from FreeLing's Spanish Resource Grammar dictionary. The source supplies complete form/lemma/POS records and grammatical features for verbs, nouns and adjectives. It replaces the small noun-gender and short-imperative allowlists. The existing lookup fallback remains conservative for missing entries.

The dictionary is pinned to FreeLing commit `0bae6b7f6d1b405e67658895de54b59bfb3b6338`. [The source manifest](../../language/spanish-lexicon-sources.json) includes SHA-256 values for each original file and the license/attribution. The build retains the original data and LGPL-LR license beside its SQLite index. Analysis reads that index locally; it makes no dictionary download or paid API call during reading. Builder output is readable by the unprivileged container user.

## General rules

- Noun gender/number normalization follows tagged noun paradigms, including *profesoras → profesor*, *escritoras → escritor*, *investigadoras → investigador* and *leonas → león*. A noun reading such as *música* remains distinct from the adjective reading of the same spelling.
- Verb selection uses grammatical candidates for the complete paradigm. Regular/irregular forms, future subjunctives and imperatives share the same selection process. The contextual model helps select ambiguous readings; alternatives stay explicit when unresolved.
- Clitic decomposition applies the grammatical ordering of up to three pronouns to any supported verb. The base form must be in the dictionary. Accent-insensitive candidate search preserves ñ and ü, while source offsets retain the exact original spelling. Exhortative s-loss and vosotros d-loss are validated against tagged imperative forms.
- Participles use explicit participle tags, including irregular *abierta → abrir*, *rota → romper* and *escrita → escribir*, under the requested learner grouping. Nouns with their own readings remain separate.
- Ordinals use attested masculine citation forms within their paradigm, including *primer → primero*; numeric dictionary identifiers never become reader headwords.
- Rare finite forms mistagged as lowercase names or alphabetical numbers can be recovered conservatively. Name/numeral safeguards preserve competing noun readings and Roman numerals; unaccented name-like clitics must also preserve the verb's stress. Other contextual POS mistakes can still survive.

The tests include a deliberately new supplied verb paradigm: one/two/three clitics, gerunds, imperative letter changes and accents work without adding that headword to the code. This is an engineering generalization check, not proof that an invented word belongs in Spanish.

Primary documentation: [FreeLing's Spanish grammatical tags](https://freeling-user-manual.readthedocs.io/en/latest/tagsets/tagset-es/), [dictionary architecture](https://freeling-user-manual.readthedocs.io/en/latest/modules/dictionary/), and [the original lexical source](https://github.com/TALP-UPC/FreeLing/tree/0bae6b7f6d1b405e67658895de54b59bfb3b6338/data/es/dictionary/entries).

## Measured checks

The comparison uses the same real spaCy 3.8.11 / `es_core_news_sm` 3.8.0 model before and after this change. Before source: Langy commit `ec510a11b4f9c5477c61a3ce95a6ff71e4ac9f97`. Each worker loads the fallback dictionary before scored inference; source/model/index fingerprints accompany the [numeric record](spanish-generalization-validation.json).

| Regression suite | Annotated source spans | Before | After |
|---|---:|---:|---:|
| Additional grammatical paradigms | 50 | 37/50 | 50/50 |
| Previous future-subjunctive cases | 62 | 62/62 | 62/62 |
| Previous reader-normalization cases | 67 | 65/67 | 65/67 |

The new key is assistant-authored and used during implementation, without independent human adjudication. Its split labels do not imply an untouched holdout experiment. The two remaining older normalization targets are contextual POS mistakes involving *frías* and *consuelo*; the dictionary is not a complete sense disambiguator.

The unchanged original Spanish challenge test changes from 81/86 to 82/86, and development from 19/21 to 18/21. Published AnCora test agreement changes from 98.73% to 98.60%; inventory F1 from 97.51% to 97.22%. Published development agreement changes from 97.74% to 96.98%. Some disagreements follow the requested noun-gender and expanded participle grouping, which differs from the reference's strict lemma conventions. All reference keys remain unchanged and all disagreements remain visible. These results do not establish a blanket improvement in strict UD lemmatization or general novel accuracy.

The app tests also verify one-time reanalysis after the previous upgrade, preservation of source words and audio, and vocabulary exposure reindexing. Docker is not available in the development environment; the index builder and runtime-user readability were checked directly, and the frontend build was verified separately.

```bash
bash scripts/benchmark-lemmas.sh --languages es --suite generalized --split all
```
