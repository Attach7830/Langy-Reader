import unittest
from vocabulary_filters import lexical_tokens, lemma_inventory


def tokens(text, surfaces, lemmas=None):
    result, position = [], 0
    for index, word in enumerate(surfaces):
        start = text.index(word, position); position = start + len(word)
        width = lambda value: len(value.encode('utf-16-le')) // 2
        result.append({'word': word, 'lemma': lemmas[index] if lemmas else word.casefold(),
                       'from': width(text[:start]), 'to': width(text[:position]), 'pos': 'NOUN', 'properName': False})
    return result


class VocabularyFilterTests(unittest.TestCase):
    def test_attached_and_hyphenated_anti_are_one_lemma_with_original_offsets(self):
        for surface in ['antihéroes', 'anti-héroes', 'anti‐héroes', 'anti‑héroes']:
            text = '😀 ' + surface
            result = lexical_tokens(text, tokens(text, ['anti', 'héroes'], ['anti', 'héroe']))
            self.assertEqual(lemma_inventory(result, 'es'), ['antihéroe'])
            self.assertEqual(result[0]['word'], surface)
            self.assertEqual(result[0]['from'], 3)
            self.assertEqual(result[0]['to'], 3 + len(surface))

    def test_a_spaced_lemma_for_a_single_prefixed_word_is_not_an_extra_entry(self):
        text = 'antihéroes'
        result = lexical_tokens(text, tokens(text, [text], ['anti héroe']))
        self.assertEqual(lemma_inventory(result, 'es'), ['antihéroe'])

    def test_standalone_anti_and_real_anti_initial_words_are_preserved(self):
        text = 'anti todo. antiguo anticipando antílope'
        result = lexical_tokens(text, tokens(text, ['anti', 'todo', 'antiguo', 'anticipando', 'antílope'], ['anti', 'todo', 'antiguo', 'anticipar', 'antílope']))
        self.assertEqual(len(result), 5)
        self.assertIn('anti', lemma_inventory(result, 'es'))
        self.assertIn('anticipar', lemma_inventory(result, 'es'))

    def test_numeral_containing_forms_are_not_lemmas_even_when_the_model_splits_them(self):
        text = 'U2 4x4 B-52 COVID-19 1.º a１２b siglo libro 2'
        source = ['U2', '4x4', 'B', 'COVID', 'º', 'a１２b', 'siglo', 'libro']
        result = lexical_tokens(text, tokens(text, source))
        self.assertEqual(lemma_inventory(result, 'es'), ['libro', 'siglo'])
        self.assertEqual(text, 'U2 4x4 B-52 COVID-19 1.º a１２b siglo libro 2')

    def test_numeric_antiprefix_form_cannot_leave_an_orphan_anti_lemma(self):
        text = 'anti-COVID-19'
        self.assertEqual(lexical_tokens(text, tokens(text, ['anti', 'COVID'])), [])

    def test_components_contractions_and_portuguese_contractions_keep_their_existing_inventory_rules(self):
        self.assertEqual(lemma_inventory([{'word': 'al', 'lemma': 'al'}, {'word': 'del', 'lemma': 'del'}], 'es'), ['a', 'de', 'el'])
        self.assertEqual(lemma_inventory([{'word': 'dos', 'lemma': 'de o', 'pos': 'ADP'}], 'pt'), ['de', 'o'])
        self.assertEqual(lemma_inventory([{'word': 'mirarlo', 'lemma': 'mirar', 'components': [{'lemma': 'mirar'}, {'lemma': 'él'}]}], 'es'), ['mirar', 'él'])


if __name__ == '__main__': unittest.main()
