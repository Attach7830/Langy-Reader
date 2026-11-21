import unittest
from book_alignment import align_recording


class BookAlignmentTests(unittest.TestCase):
    def test_intro_outro_and_different_word_boundaries_preserve_source_timing(self):
        words = 'La niña encontró un mapa antiguo debajo de la mesa. Después cruzó el jardín y siguió el camino hacia la montaña.'.split()
        spoken = ['Introducción', 'del', 'narrador', *words, 'Fin', 'de', 'la', 'grabación']
        heard = [{"word": word, "start": index * .3, "end": (index + .8) * .3} for index, word in enumerate(spoken)]
        result = align_recording(words, heard)
        self.assertEqual(result['matchedWords'], len(words))
        self.assertAlmostEqual(result['timings'][0]['start'], .9)
        self.assertGreater(result['matchedSpeechRatio'], .6)
        self.assertTrue(all(a['end'] <= b['start'] for a, b in zip(result['timings'], result['timings'][1:])))

    def test_character_anchors_support_cjk_segmentation(self):
        words = ['小明', '走进', '安静', '图书馆', '寻找', '古老', '地图']
        heard = [{"word": char, "start": i * .2, "end": (i + 1) * .2} for i, char in enumerate(''.join(words))]
        result = align_recording(words, heard)
        self.assertEqual(result['matchedWords'], len(words))
        self.assertEqual(result['timings'][1]['start'], .4)

    def test_unrelated_recording_does_not_get_a_fabricated_book_timeline(self):
        words = ('caballo montaña bosque riachuelo naranja palacio aventurero ' * 1000).split()
        heard = [{"word": word, "start": i, "end": i + .5} for i, word in enumerate(('quantum software electric engineering ' * 20).split())]
        result = align_recording(words, heard)
        self.assertEqual(result['strongMatchCharacters'], 0)
        self.assertEqual(result['matchedWords'], 0)

    def test_long_repetitive_beginner_text_can_match_without_unique_phrases(self):
        words = ('El gato mira al perro y el perro mira al gato. ' * 100).split()
        spoken = ['Introducción', *words, 'Fin']
        heard = [{"word": word, "start": i * .2, "end": (i + .8) * .2} for i, word in enumerate(spoken)]
        result = align_recording(words, heard)
        self.assertEqual(result['matchedWords'], len(words))
        self.assertAlmostEqual(result['timings'][0]['start'], .2)


if __name__ == '__main__':
    unittest.main()
