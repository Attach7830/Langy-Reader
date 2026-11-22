import types
import unittest
from unittest.mock import patch

from spanish_morphology import build_future_index, future_subjunctive, spanish_future_correction


LOOKUP = {"hubieron": "haber", "tuvieron": "tener", "cantaron": "cantar", "hablaron": "hablar", "hicieron": "hacer", "dijeron": "decir",
          "oyeron": "oír", "fueron": "ser", "vinieron": "venir", "leyeron": "leer", "produjeron": "producir", "sostuvieron": "sostener"}


def token(word, lemma="inventar", pos="VERB", before=(), after=()):
    parts = [types.SimpleNamespace(text=text, pos_=kind, morph=morph, is_space=False) for text, kind, morph in before]
    result = types.SimpleNamespace(text=word, lemma_=lemma, pos_=pos, morph="", i=len(parts))
    parts.append(result)
    parts.extend(types.SimpleNamespace(text=text, pos_=kind, morph=morph, is_space=False) for text, kind, morph in after)
    result.doc = parts
    return result


class FutureSubjunctiveTests(unittest.TestCase):
    def setUp(self):
        self.patch = patch("spanish_morphology.future_index", return_value=build_future_index(LOOKUP))
        self.patch.start(); self.addCleanup(self.patch.stop)
        alternatives = patch("spanish_morphology.alternative_index", return_value={"amare": "amarar", "equipare": "equiparar"})
        alternatives.start(); self.addCleanup(alternatives.stop)
        participles = patch("spanish_morphology.participle_index", return_value={"terminado": "terminar"})
        participles.start(); self.addCleanup(participles.stop)

    def test_all_future_person_forms_recover_the_attested_verb(self):
        for word in ["tuviere", "tuvieres", "tuviéremos", "tuviereis", "tuvieren"]:
            with self.subTest(word=word):
                result = future_subjunctive(token(word, "tuvierir"))
                self.assertEqual(result["lemma"], "tener"); self.assertFalse(result["lemmaUncertain"])

    def test_regular_ar_forms_keep_the_correct_plural_stress(self):
        for word in ["cantare", "cantares", "cantáremos", "cantareis", "cantaren"]:
            self.assertEqual(future_subjunctive(token(word))["lemma"], "cantar")
        self.assertEqual(future_subjunctive(token("habláremos"))["lemma"], "hablar")

    def test_present_and_future_indicative_accents_are_not_silently_changed(self):
        for word in ["cantaremos", "cantaré", "cantaréis", "hablemos", "habléremos", "quiere"]:
            self.assertIsNone(future_subjunctive(token(word)))

    def test_irregular_derived_and_y_spelling_paradigms_are_recovered(self):
        for word, lemma in [("hiciere", "hacer"), ("dijeren", "decir"), ("oyéremos", "oír"), ("leyere", "leer"), ("viniere", "venir"), ("produjere", "producir"), ("sostuvieren", "sostener")]:
            self.assertEqual(future_subjunctive(token(word))["lemma"], lemma)

    def test_case_and_decomposed_unicode_preserve_the_same_lemma(self):
        self.assertEqual(future_subjunctive(token("HUBIERE"))["lemma"], "haber")
        self.assertEqual(future_subjunctive(token("hubie\u0301remos"))["lemma"], "haber")

    def test_nouns_and_proper_names_are_not_relabelled_as_future_verbs(self):
        for word, lemma, pos in [("cantares", "cantar", "NOUN"), ("Cantare", "cantare", "PROPN"), ("pesares", "pesar", "NOUN")]:
            self.assertIsNone(future_subjunctive(token(word, lemma, pos)))

    def test_unknown_suffixes_do_not_create_infinitives(self):
        for word in ["hubierir", "xylophoniere", "madre", "mujeres", "poderes"]:
            self.assertIsNone(future_subjunctive(token(word)))

    def test_ordinary_dictionary_entries_do_not_seed_a_future_paradigm(self):
        index = build_future_index({"hogares": "hogar", "ron": "ron", "señorón": "señor", "cantares": "cantar"})
        self.assertEqual(index, {})

    def test_directional_and_copular_fuere_are_distinguished_in_clear_constructions(self):
        going = future_subjunctive(token("fuere", "fuerar", before=[("Adonde", "ADV", "")], after=[("el", "DET", ""), ("viajero", "NOUN", "")]))
        self.assertEqual(going["lemma"], "ir"); self.assertFalse(going["lemmaUncertain"])
        being = future_subjunctive(token("fuere", "fuerir", after=[("necesario", "ADJ", "")]))
        self.assertEqual(being["lemma"], "ser"); self.assertFalse(being["lemmaUncertain"])

    def test_passive_and_fixed_concessive_fuere_keep_ser(self):
        passive = future_subjunctive(token("fuere", after=[("elegido", "VERB", "VerbForm=Part")]))
        self.assertEqual(passive["lemma"], "ser")
        fixed = future_subjunctive(token("fuere", before=[("Sea", "AUX", ""), ("quien", "PRON", "")]))
        self.assertEqual(fixed["lemma"], "ser"); self.assertFalse(fixed["lemmaUncertain"])

    def test_unresolved_fuere_exposes_both_candidates_without_counting_both(self):
        result = future_subjunctive(token("fueren", "ir"))
        self.assertEqual(result["lemma"], "ir"); self.assertTrue(result["lemmaUncertain"])
        self.assertEqual(result["lemmaCandidates"], ["ir", "ser"])
        unknown = future_subjunctive(token("fuere", "fuerir"))
        self.assertIn(unknown["lemma"], ["ir", "ser"]); self.assertTrue(unknown["lemmaUncertain"])

    def test_mistagged_nouns_require_a_narrow_clause_frame_and_no_nominal_reading(self):
        for word, lemma, before in [("hubieres", "haber", ["Si"]), ("tuviereis", "tener", ["Si", "vosotros"]), ("fueres", "ir", ["Adonde"])]:
            result = future_subjunctive(token(word, "bad", "NOUN", before=[(part, "X", "") for part in before]))
            self.assertEqual(result["lemma"], lemma)
            self.assertEqual(result["pos"], "VERB")
        self.assertIsNone(future_subjunctive(token("cantares", "cantar", "NOUN", before=[("Si", "SCONJ", "")])))
        self.assertIsNone(future_subjunctive(token("tuviereis", "bad", "NOUN", before=[("Si", "SCONJ", ""), ("los", "DET", ""), ("antiguos", "ADJ", "")])))
        self.assertIsNone(future_subjunctive(token("hubieres", "hubier", "NOUN")))

    def test_compound_future_recovers_the_attested_participle_without_touching_adjectives_elsewhere(self):
        auxiliary = token("hubieres", "hubier", "NOUN", before=[("Si", "SCONJ", "")])
        part = types.SimpleNamespace(text="terminado", lemma_="terminado", pos_="ADJ", morph="VerbForm=Part", i=2)
        auxiliary.doc.append(part); part.doc = auxiliary.doc
        self.assertEqual(spanish_future_correction(part)["lemma"], "terminar")
        auxiliary.text = "trabajo"
        self.assertIsNone(spanish_future_correction(part))

    def test_overlapping_present_subjunctive_readings_are_not_forced_to_future(self):
        with patch("spanish_morphology.future_index", return_value={"equipare": ("equipar",), "amare": ("amar",)}):
            for form, lemma in [("equipare", "equiparar"), ("amare", "amarar")]:
                result = future_subjunctive(token(form, lemma))
                self.assertEqual(result["lemma"], lemma)
                self.assertTrue(result["lemmaUncertain"])
                self.assertIn(lemma, result["lemmaCandidates"])
                self.assertEqual(result["morphology"], "")


if __name__ == "__main__":
    unittest.main()
