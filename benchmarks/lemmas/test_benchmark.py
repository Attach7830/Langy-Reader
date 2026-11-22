import copy
import json
from pathlib import Path
import tempfile
import unittest

from core import expand_challenge, inventory, parse_conllu, sample_cases, score_case, summarize, utf16, validate_cases
from prepare_corpora import checked_download


def case(text, answers, complete=True, language="es", kind=None):
    raw = {"id": language + "-example", "language": language, "split": "test", "text": text, "answers": answers}
    if kind:
        raw["kind"] = kind
    result = expand_challenge({"cases": [raw]})[0]
    result["complete"] = complete
    return result


def prediction(reference):
    groups = copy.deepcopy(reference["groups"])
    return {"groups": groups, "inventory": sorted(inventory(groups))}


class BenchmarkTests(unittest.TestCase):
    def test_spanish_reader_normalization_key_is_valid_and_separate_from_reference_lemmas(self):
        data = json.loads(Path(__file__).with_name("spanish-forms.json").read_text())
        rows = expand_challenge(data)
        validate_cases(rows)
        self.assertEqual(len(rows), 49)
        self.assertEqual(sum(len(row["groups"]) for row in rows), 67)
        self.assertEqual({row["suite"] for row in rows}, {"spanish-forms"})
        self.assertTrue(all(not row["complete"] for row in rows))

    def test_future_subjunctive_key_is_valid_and_reported_separately(self):
        data = json.loads(Path(__file__).with_name("spanish-future.json").read_text())
        rows = expand_challenge(data)
        validate_cases(rows)
        self.assertEqual(len(rows), 60)
        self.assertEqual({row["suite"] for row in rows}, {"spanish-future"})
        self.assertEqual({row["language"] for row in rows}, {"es"})
        self.assertEqual({row["split"] for row in rows}, {"dev", "test"})
        self.assertTrue(all(not row["complete"] for row in rows))

    def test_entire_original_answer_key_is_valid_and_covers_languages_and_splits(self):
        data = json.loads(Path(__file__).with_name("challenge.json").read_text())
        rows = expand_challenge(data)
        self.assertEqual(len(rows), 105)
        self.assertEqual(sum(len(row["groups"]) for row in rows), 299)
        self.assertEqual({row["language"] for row in rows}, {"es", "pt", "en", "zh"})
        for language in {"es", "pt", "en", "zh"}:
            self.assertEqual({row["split"] for row in rows if row["language"] == language}, {"dev", "test"})
        self.assertTrue(all(not row["complete"] for row in rows if row["suite"] == "challenge"))

    def test_repeated_forms_keep_different_contextual_lemmas(self):
        row = case("Vino y bebió vino.", [["Vino", [["venir", "VERB"]]], ["vino", [["vino", "NOUN"]]]])
        self.assertEqual([word["components"][0]["lemma"] for word in row["groups"]], ["venir", "vino"])
        self.assertEqual(score_case(row, prediction(row))["correct"], 2)

    def test_targets_match_whole_surface_words_not_substrings_in_the_context(self):
        text = "Todas as manhãs canto perto da janela."
        row = case(text, [["da", [["de", "ADP"], ["o", "DET"]]], ["manhãs", [["manhã", "NOUN"]]]])
        self.assertEqual([group["form"] for group in row["groups"]], ["manhãs", "da"])
        self.assertEqual(row["groups"][1]["from"], text.index("da janela"))
        other = case("Passamos pelo mercado antes do almoço.", [["do", [["de", "ADP"], ["o", "DET"]]]])
        self.assertEqual(other["groups"][0]["from"], 28)

    def test_different_tokenizations_of_a_contraction_can_share_the_correct_source_answer(self):
        row = case("don't", [["don't", [["do", "AUX"], ["not", "PART"]]]])
        actual = {"groups": [{"from": 0, "to": 2, "components": [{"lemma": "do", "upos": "AUX"}]},
                             {"from": 2, "to": 5, "components": [{"lemma": "not", "upos": "PART"}]}], "inventory": ["do", "not"]}
        scored = score_case(row, actual)
        self.assertEqual(scored["correct"], 1); self.assertEqual(scored["unaligned"], 0)

    def test_half_a_word_with_a_correct_lemma_does_not_pass(self):
        row = case("libros", [["libros", [["libro", "NOUN"]]]])
        actual = prediction(row); actual["groups"][0]["to"] = 3
        self.assertEqual(score_case(row, actual)["correct"], 0)

    def test_a_merged_prediction_cannot_hide_a_segmentation_error(self):
        row = case("libros mesas", [["libros", [["libro", "NOUN"]]], ["mesas", [["mesa", "NOUN"]]]])
        actual = {"groups": [{"from": 0, "to": 12, "components": [{"lemma": "libro", "upos": "NOUN"}, {"lemma": "mesa", "upos": "NOUN"}]}], "inventory": ["libro", "mesa"]}
        result = score_case(row, actual)
        self.assertEqual(result["correct"], 0); self.assertEqual(result["unaligned"], 1)

    def test_equal_vocabulary_totals_still_reveal_false_and_missing_entries(self):
        row = case("libros mesas", [["libros", [["libro", "NOUN"]]], ["mesas", [["mesa", "NOUN"]]]])
        actual = prediction(row); actual["groups"][1]["components"][0]["lemma"] = "silla"; actual["inventory"] = ["libro", "silla"]
        result = summarize([score_case(row, actual)])
        self.assertEqual(result["accuracy"], .5); self.assertEqual(result["inventory_f1"], .5)
        self.assertEqual(result["false_entries"], 1); self.assertEqual(result["missed_entries"], 1)

    def test_partial_challenges_ignore_unannotated_context_and_omit_inventory_scores(self):
        row = case("Vino al pueblo.", [["Vino", [["venir", "VERB"]]]], complete=False)
        actual = prediction(row); actual["groups"].append({"from": 5, "to": 7, "components": [{"lemma": "al", "upos": "ADP"}]}); actual["inventory"].append("al")
        result = summarize([score_case(row, actual)])
        self.assertEqual(result["accuracy"], 1); self.assertEqual(result["unaligned_spans"], 0)
        self.assertIsNone(result["inventory_f1"]); self.assertIsNone(result["false_entries"])

    def test_false_name_exclusions_are_visible_even_when_the_lemma_is_correct(self):
        row = case("rosas", [["rosas", [["rosa", "NOUN"]]]])
        actual = prediction(row); actual["groups"][0]["components"][0]["excluded"] = True; actual["inventory"] = []
        result = summarize([score_case(row, actual)])
        self.assertEqual(result["accuracy"], 1); self.assertEqual(result["false_name_exclusions"], 1)
        self.assertEqual(result["missed_entries"], 1)

    def test_missing_names_and_potential_merges_are_reported(self):
        first = case("vino", [["vino", [["venir", "VERB"]]]])
        second = case("vino", [["vino", [["vino", "NOUN"]]]])
        actual = prediction(second)
        result = summarize([score_case(first, actual), score_case(second, actual)])
        self.assertEqual(result["potential_merges"], {"vino": ["venir", "vino"]})
        named = case("Rosa", [["Rosa", [["rosa", "PROPN"]]]])
        wrong = prediction(named); wrong["groups"][0]["components"][0]["upos"] = "NOUN"
        self.assertEqual(score_case(named, wrong)["missed_names"], 1)

    def test_astral_characters_keep_browser_utf16_positions(self):
        row = case("𠮷书", [["𠮷", [["𠮷", "X"]]], ["书", [["书", "X"]]]], language="zh", kind="characters")
        self.assertEqual(utf16("𠮷书"), 3)
        self.assertEqual([(item["from"], item["to"]) for item in row["groups"]], [(0, 2), (2, 3)])
        self.assertEqual(score_case(row, prediction(row))["correct"], 2)

    def test_accents_and_enye_remain_distinct(self):
        row = case("año", [["año", [["año", "NOUN"]]]])
        actual = prediction(row); actual["groups"][0]["components"][0]["lemma"] = "ano"; actual["inventory"] = ["ano"]
        self.assertEqual(score_case(row, actual)["correct"], 0)

    def test_conllu_parsing_keeps_mwt_parents_and_ignores_empty_nodes(self):
        text = '''# sent_id = one
# text = Vámonos al mar.
1-2\tVámonos\t_\t_\t_\t_\t_\t_\t_\t_
1\tvamos\tir\tVERB\t_\t_\t0\troot\t_\t_
2\tnos\tyo\tPRON\t_\t_\t1\tobj\t_\t_
3-4\tal\t_\t_\t_\t_\t_\t_\t_\t_
3\ta\ta\tADP\t_\t_\t5\tcase\t_\t_
4\tel\tel\tDET\t_\t_\t5\tdet\t_\t_
5\tmar\tmar\tNOUN\t_\t_\t1\tobl\t_\tSpaceAfter=No
5.1\tfantasma\tfantasma\tNOUN\t_\t_\t_\t_\t1:obj\t_
6\t.\t.\tPUNCT\t_\t_\t1\tpunct\t_\t_
'''
        rows, rejected = parse_conllu(text, "es", "test-source", "test")
        self.assertFalse(rejected); self.assertEqual(len(rows), 1)
        self.assertEqual([group["form"] for group in rows[0]["groups"]], ["Vámonos", "al", "mar"])
        self.assertEqual(rows[0]["groups"][0]["components"][1]["lemma"], "yo")
        self.assertEqual(score_case(rows[0], prediction(rows[0]))["correct"], 3)

    def test_reference_alignment_failures_are_recorded_before_model_selection(self):
        text = '# sent_id = invalid\n# text = casas\n1\tlibros\tlibro\tNOUN\t_\t_\t0\troot\t_\t_\n'
        rows, rejected = parse_conllu(text, "es", "source", "test")
        self.assertFalse(rows); self.assertEqual(len(rejected), 1)

    def test_reference_sampling_is_stable_and_does_not_depend_on_input_order(self):
        rows = expand_challenge(json.loads(Path(__file__).with_name("challenge.json").read_text()))
        self.assertEqual(sample_cases(rows, 20), sample_cases(list(reversed(rows)), 20))
        with self.assertRaisesRegex(ValueError, "Duplicate case"):
            validate_cases([rows[0], rows[0]])

    def test_download_checksum_mismatches_cannot_replace_a_reference_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "source"
            with self.assertRaisesRegex(ValueError, "checksum"):
                checked_download("data:text/plain,wrong", "0" * 64, path)
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
