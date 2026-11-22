import hashlib
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from prepare_spanish_lexicon import build_index, prepare
from spanish_dictionary import correction
from spanish_lexicon import readings, metadata


# Small original fixtures in the documented EAGLES format. The artificial zarpelar
# paradigm verifies that decomposition is driven by supplied data, not a word list.
FIXTURE = """profesoras profesor NCFP000
investigadoras investigador NCFP000
campeonas campeón NCFP000
leonas león NCFP000
manzana manzana NCFS000
manzano manzano NCMS000
bolsa bolsa NCFS000
bolso bolso NCMS000
música música NCFS000
música músico AQ0FS00
políticas política NCFP000
políticas político NCFP000
rota romper VMP00SF
escrita escribir VMP00SF
zarpelar zarpelar VMN0000
zarpelando zarpelar VMG0000
zarpelad zarpelar VMM02P0
zarpela zarpelar VMM02S0
zarpelamos zarpelar VMM01P0
zarpelá zarpelar VMM02S0
zarpelasteis zarpelar VMIS2P0
dé dar VMM03S0
sé ser VSM02S0
da dar VMM02S0
di decir VMM02S0
di dar VMIS1S0
dijo decir VMIS3S0
tomate tomate NCMS000
regalo regalo NCMS000
regalo regalar VMIP1S0
marce marcir VMIP3S0
marce marcir VMM02S0
fui ir VMIS1S0
fui ser VSIS1S0
segunda 2 AO0FS00
segundo 2 AO0MS00
segundas 2 AO0FP00
segunda segundar VMIP3S0
primer 1 AO0MS00
primero 1 AO0MS00
pese pesar VMSP3S0
vi ver VMIS1S0
"""


def token(word, lemma="unknown", pos="VERB", morph="", previous=None):
    result = types.SimpleNamespace(text=word, lemma_=lemma, pos_=pos, morph=morph, i=1 if previous else 0)
    result.doc = ([types.SimpleNamespace(text=previous, pos_="CCONJ", is_punct=False)] if previous else []) + [result]
    return result


class TaggedSpanishTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        source = self.folder / "forms.txt"; source.write_text(FIXTURE)
        self.path = self.folder / "lexicon.sqlite"
        build_index(self.path, [source], {"commit": "test-fixture", "files": []})
        env = patch.dict(os.environ, {"LANGY_SPANISH_LEXICON": str(self.path)})
        env.start(); self.addCleanup(env.stop)

    def test_noun_pairs_use_tagged_lemmas_including_or_and_irregular_feminines(self):
        for form, lemma in [("profesoras", "profesor"), ("investigadoras", "investigador"), ("campeonas", "campeón"), ("leonas", "león")]:
            self.assertEqual(correction(token(form, form, "NOUN"))["lemma"], lemma)

    def test_pos_distinguishes_music_from_musician_and_keeps_other_nouns_distinct(self):
        for form in ["música", "manzana", "manzano", "bolsa", "bolso"]:
            self.assertEqual(correction(token(form, form, "NOUN"))["lemma"], form)
        self.assertEqual(correction(token("música", "música", "ADJ"))["lemma"], "músico")
        ambiguous = correction(token("políticas", "política", "NOUN"))
        self.assertEqual(ambiguous["lemma"], "política")
        self.assertEqual(ambiguous["lemmaCandidates"], ["política", "político"])
        self.assertTrue(ambiguous["lemmaUncertain"])

    def test_irregular_participles_are_recovered_from_grammatical_tags(self):
        for form, lemma in [("rota", "romper"), ("escrita", "escribir")]:
            self.assertEqual(correction(token(form, form, "ADJ"))["lemma"], lemma)
        for form, lemma in [("segunda", "segundo"), ("segundas", "segundo"), ("primer", "primero")]:
            self.assertEqual(correction(token(form, lemma, "ADJ"))["lemma"], lemma)

    def test_a_supplied_new_paradigm_accepts_clitic_combinations_without_code_changes(self):
        for form, pronouns in [("zarpelarme", ["yo"]), ("zarpelándomelos", ["yo", "él"]),
                                ("zarpelárselas", ["él", "él"]), ("zarpelártemelo", ["tú", "yo", "él"]),
                                ("zarpeladlo", ["él"]), ("zarpelaos", ["tú"]), ("zarpelámonos", ["yo"])]:
            result = correction(token(form))
            self.assertEqual(result["lemma"], "zarpelar")
            self.assertEqual([part["lemma"] for part in result["components"][1:]], pronouns)
            self.assertEqual(result["components"][-1]["to"], len(form))
        self.assertIsNone(correction(token("unknownándome")))

    def test_imperatives_restore_accents_and_work_after_conjunctions_without_a_short_word_list(self):
        for form, lemma in [("Deme", "dar"), ("Dámelo", "dar"), ("Dímelo", "decir"), ("zarpeladlo", "zarpelar")]:
            self.assertEqual(correction(token(form, pos="PROPN", previous="y"))["lemma"], lemma)
        for form in ["Marcelo", "Carmelo"]:
            self.assertIsNone(correction(token(form, form.lower(), "PROPN")))
        self.assertEqual(correction(token("zarpelasteis", pos="PROPN"))["lemma"], "zarpelar")
        self.assertIsNone(correction(token("Zarpelasteis", pos="PROPN")))
        self.assertEqual(correction(token("zarpelasteis", pos="NUM"))["lemma"], "zarpelar")
        for form in ["VI", "vi", "200", "veinte"]:
            self.assertIsNone(correction(token(form, pos="NUM")))
        self.assertEqual(correction(token("díjome"))["lemma"], "decir")
        item = token("zarpeladlo", pos="PROPN")
        item.i = 2; item.doc = [types.SimpleNamespace(pos_="PUNCT", is_punct=True), types.SimpleNamespace(pos_="ADV"), item]
        self.assertEqual(correction(item)["lemma"], "zarpelar")

    def test_complete_noun_and_verb_readings_are_not_split_by_suffixes(self):
        for form, lemma, pos in [("tomate", "tomate", "NOUN"), ("regalo", "regalo", "NOUN"), ("regalo", "regalar", "VERB")]:
            result = correction(token(form, lemma, pos))
            self.assertEqual(result["lemma"], lemma)
            self.assertNotIn("components", result)
        for pos in ["ADP", "ADV", "SCONJ", "PRON"]:
            self.assertIsNone(correction(token("déme", "déme", pos)))
        self.assertIsNone(correction(token("pese", "pese", "NOUN")))

    def test_index_reads_are_offline_and_accents_and_enye_survive(self):
        self.assertTrue(self.path.stat().st_mode & 0o004, "The runtime user must be able to read the build-time dictionary")
        with patch("urllib.request.urlopen", side_effect=AssertionError("Inference attempted a download")):
            self.assertEqual(readings("leonas")[0]["lemma"], "león")
            self.assertEqual(readings("de", folded=True)[0]["lemma"], "dar")
            self.assertEqual(metadata()["entries"], len(FIXTURE.strip().splitlines()))
            self.assertEqual(metadata()["source_commit"], "test-fixture")

    def test_build_pins_and_retains_the_source_data_and_rejects_wrong_checksums(self):
        cached = self.folder / "cache"; cached.mkdir()
        (cached / "MM.test").write_text(FIXTURE)
        raw = FIXTURE.encode()
        manifest = {"commit": "fixture", "attribution": "Original test data", "repository": "https://example.test",
                    "files": [{"path": "MM.test", "url": "https://example.test/data", "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]}
        output = self.folder / "prepared"
        with patch("prepare_spanish_lexicon.json.loads", return_value=manifest), patch("urllib.request.urlopen", side_effect=AssertionError("Cache missed")):
            prepare(output, cached)
            self.assertEqual((output / "sources/MM.test").read_text(), FIXTURE)
            (cached / "MM.test").write_text("tampered data")
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                prepare(output, cached)


if __name__ == "__main__":
    unittest.main()
