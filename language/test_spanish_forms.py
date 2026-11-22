import types
import unittest
from unittest.mock import patch

from spanish_morphology import build_conjugation_data, spanish_correction
from spanish_lexicon import decode


LOOKUP = {"miraron": "mirar", "mira": "mirar", "mirando": "mirar", "miró": "mirar",
          "achicaron": "achicar", "achicando": "achicar", "agregaron": "agregar", "agregando": "agregar",
          "aproximaron": "aproximar", "dieron": "dar", "da": "dar", "dé": "dar", "di": "decir",
          "diga": "decir", "diciendo": "decir", "trae": "traer", "sentemos": "sentar", "sentad": "sentar",
          "pongamos": "poner", "vamos": "ir", "sintiendo": "sentir", "llevaron": "llevar",
          "hablaron": "hablar", "habló": "hablar", "hablé": "hablar", "comieron": "comer", "comiste": "comer",
          "oyeron": "oír", "oyó": "oír", "vinieron": "venir", "vino": "venir", "vinos": "vino", "fui": "ser",
          "adultas": "adulto", "adulta": "adulto", "adultos": "adulto", "frías": "frío",
          "almizclada": "almizclar", "almizclado": "almizclar", "vestidos": "vestir", "alto": "altar",
          "tomates": "tomate", "modelos": "modelo", "consuelos": "consuelo", "regalo": "regalar",
          "regalos": "regalo", "camelo": "camelar", "óvalos": "óvalo", "ova": "ovar",
          "bolsas": "bolsa", "bolsos": "bolso", "cuchillas": "cuchilla", "cuchillos": "cuchillo",
          "música": "músico", "líneas": "líneo", "políticas": "político",
          "parte": "partir", "partieron": "partir", "combate": "combatir", "combatieron": "combatir",
          "marce": "marcir"}


def token(word, lemma="incorrecto", pos="VERB", morph=""):
    result = types.SimpleNamespace(text=word, lemma_=lemma, pos_=pos, morph=morph, i=0)
    result.doc = [result]
    return result


class SpanishFormTests(unittest.TestCase):
    def setUp(self):
        mock = patch("spanish_morphology.conjugation_data", return_value=build_conjugation_data(LOOKUP))
        mock.start(); self.addCleanup(mock.stop)
        # The tagged layer supplies noun paradigms and homographs; the remaining
        # cases also exercise the conservative no-index fallback.
        facts = {"adulta": [("adulto", "NOUN", "NCFS000")], "adultas": [("adulto", "NOUN", "NCFP000")],
                 "adultos": [("adulto", "NOUN", "NCMP000")],
                 "fui": [("ir", "VERB", "VMIS1S0"), ("ser", "VERB", "VSIS1S0")],
                 "di": [("dar", "VERB", "VMIS1S0"), ("decir", "VERB", "VMM02S0")]}
        tagged = patch("spanish_dictionary.readings", side_effect=lambda word, folded=False: tuple(decode(*row) for row in facts.get(word, [])))
        tagged.start(); self.addCleanup(tagged.stop)

    def test_infinitives_split_one_two_and_three_pronouns(self):
        for word, expected in [("mirarlo", ["mirar", "él"]), ("achicarme", ["achicar", "yo"]),
                               ("agregárselo", ["agregar", "él", "él"]), ("aproximársele", ["aproximar", "él", "él"]),
                               ("llevártemelo", ["llevar", "tú", "yo", "él"])]:
            with self.subTest(word=word):
                result = spanish_correction(token(word))
                self.assertEqual([part["lemma"] for part in result["components"]], expected)
                self.assertEqual(result["lemma"], expected[0])
                self.assertEqual(result["components"][-1]["to"], len(word))

    def test_gerunds_recover_the_attested_base_including_irregular_stems(self):
        for word, expected in [("achicándome", "achicar"), ("agregándoselo", "agregar"), ("mirándola", "mirar"),
                               ("diciéndome", "decir"), ("sintiéndose", "sentir")]:
            self.assertEqual(spanish_correction(token(word))["lemma"], expected)

    def test_imperatives_can_be_recovered_from_mistagged_nouns_and_names(self):
        for word, expected, pos in [("Dámelo", "dar", "PROPN"), ("tráemelo", "traer", "NOUN"),
                                    ("dígame", "decir", "NOUN"), ("deme", "dar", "NOUN")]:
            self.assertEqual(spanish_correction(token(word, word, pos))["lemma"], expected)

    def test_exhortative_s_and_vosotros_d_are_restored_from_attested_forms(self):
        for word, expected in [("sentémonos", "sentar"), ("sentaos", "sentar"), ("pongámoselo", "poner"), ("vámonos", "ir")]:
            self.assertEqual(spanish_correction(token(word))["lemma"], expected)

    def test_real_nouns_and_whole_verbs_are_not_split_by_similar_endings(self):
        for word, pos, lemma in [("tomate", "NOUN", "tomate"), ("modelo", "NOUN", "modelo"), ("consuelo", "NOUN", "consuelo"),
                                  ("regalo", "NOUN", "regalo"), ("camelo", "VERB", "camelar"), ("óvalo", "NOUN", "óvalo")]:
            self.assertIsNone(spanish_correction(token(word, lemma, pos)))

    def test_unaccented_proper_names_are_preserved(self):
        for word in ["Marcelo", "Carmelo", "Consuelo"]:
            self.assertIsNone(spanish_correction(token(word, word.lower(), "PROPN")))

    def test_unknown_stems_do_not_create_a_verb_from_a_suffix(self):
        for word in ["xilofonárselo", "xyzándome", "inventadome"]:
            self.assertIsNone(spanish_correction(token(word)))

    def test_decomposed_accent_and_extra_stress_keep_original_source_ranges(self):
        word = "mira\u0301ndome"
        result = spanish_correction(token(word))
        self.assertEqual(result["lemma"], "mirar")
        self.assertEqual(word[result["components"][1]["from"]:result["components"][1]["to"]], "me")
        self.assertEqual(spanish_correction(token("aproximárse"))["lemma"], "aproximar")

    def test_past_forms_and_accented_infinitives_share_the_attested_base(self):
        for word, wrong, expected in [("habló", "habló", "hablar"), ("oyó", "oir", "oír"), ("oyeron", "oir", "oír")]:
            self.assertEqual(spanish_correction(token(word, wrong, morph="Tense=Past"))["lemma"], expected)
        self.assertIsNone(spanish_correction(token("vino", "vino", "NOUN")))
        for word, expected in [("hablé", "hablar"), ("miró", "mirar"), ("comiste", "comer")]:
            self.assertEqual(spanish_correction(token(word, word, "NOUN"))["lemma"], expected)
        for word in ["parte", "combate"]:
            self.assertIsNone(spanish_correction(token(word, word, "NOUN")))

    def test_shared_ser_ir_and_dar_decir_forms_keep_contextual_candidates(self):
        for word, lemma in [("fui", "ir"), ("fui", "ser"), ("di", "dar"), ("di", "decir")]:
            result = spanish_correction(token(word, lemma, morph="Tense=Past"))
            self.assertEqual(result["lemma"], lemma)
            self.assertTrue(result["lemmaUncertain"])

    def test_attested_masculine_feminine_and_plural_pairs_share_one_headword(self):
        for word, expected in [("adulta", "adulto"), ("adultas", "adulto"), ("adultos", "adulto"), ("frías", "frío")]:
            self.assertEqual(spanish_correction(token(word, word, "ADJ" if word == "frías" else "NOUN"))["lemma"], expected)

    def test_adjectival_participles_join_the_verb_while_lexical_nouns_remain(self):
        for word in ["almizclada", "almizclado"]:
            result = spanish_correction(token(word, "almizclado", "ADJ", "VerbForm=Part"))
            self.assertEqual(result["lemma"], "almizclar")
            self.assertEqual(result["modelLemma"], "almizclado")
        for word in ["vestido", "alto"]:
            self.assertIsNone(spanish_correction(token(word, word, "NOUN" if word == "vestido" else "ADJ")))

    def test_unrelated_o_a_nouns_are_not_forced_into_one_gender_pair(self):
        for word in ["bolsa", "bolso", "cuchilla", "cuchillo", "música", "líneas", "políticas"]:
            self.assertIsNone(spanish_correction(token(word, word, "NOUN")))


if __name__ == "__main__":
    unittest.main()
