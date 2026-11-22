# Recorded pilot comparison

Run `20261122T172020Z-5d08e2` evaluated the supplied test split with the real pinned models in separate CPU processes (four threads each). The Python execution, model/resource downloads and reference preparation completed successfully. The Docker wrapper has command-isolation tests; a Docker daemon was not available in the development environment, so the image itself was not built there.

Selected answer-key SHA-256: `a5a7602a994cea4294b2673dec660a142996eac0d17bec36c2661d423d2048c4`.

The reproducible numeric record is [validation.json](validation.json). Package/model versions, model-file hashes and the exact Langy analysis source hash are included. No production analyzer was changed or tuned against these results.

## Published reference sentences

| Language | Source-word spans | Langy source-word agreement | Stanza source-word agreement | Langy inventory F1 | Stanza inventory F1 |
|---|---:|---:|---:|---:|---:|
| Spanish | 787 | 99.62% | 98.86% | 99.12% | 97.96% |
| Portuguese | 740 | 97.30% | 98.51% | 95.07% | 97.84% |
| English | 811 | 96.55% | 98.27% | 92.94% | 96.62% |

## Original challenge targets

| Language | Targets | Langy exact matches | Stanza exact matches |
|---|---:|---:|---:|
| Spanish | 86 | 78/86 (90.70%) | 83/86 (96.51%) |
| Portuguese | 73 | 60/73 (82.19%) | 67/73 (91.78%) |
| English | 55 | 50/55 (90.91%) | 51/55 (92.73%) |

The separate Mandarin regression checks matched all 27 test character occurrences and their inventory. Mandarin character counting was not treated as a Stanza lemma comparison.

## Interpretation

Stanza agreed with more of the original hard targets in all three languages and improved the published Portuguese/English results in this pilot. Langy’s existing analyzer agreed with more of the published Spanish reference and its vocabulary inventory. A larger candidate therefore did not improve every measure or language. This supports a language-specific evaluation rather than an automatic replacement.

Stanza used more warmed CPU time and worker memory in this environment. Those measurements are in the numeric record; your server’s timings will differ. This comparison is too small and domain-limited to establish general novel accuracy or statistical superiority. The challenge key is assistant-authored without independent human adjudication; the published references have their upstream annotation conventions and histories. Name-filter differences between the candidates are explicitly recorded.

The source-word metric is the benchmark’s exact lemma-multiset agreement at an original surface span, including contractions/attached pronouns. It is not the standard UD token-level score. Inventory F1 compares the union of reference/predicted non-name lemmas within each language/suite. See [the scoring and provenance notes](README.md) before interpreting disagreements as linguistic errors.
