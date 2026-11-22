import base64
import types
import unittest
import numpy as np
from unittest.mock import patch

from app import Alignment, Analysis, analyze, align, match_timings, normalized, recognized_words, rescan_recording


def speech_word(word, start, end):
    return types.SimpleNamespace(word=word, start=start, end=end, probability=0.9)


class AlignmentTests(unittest.TestCase):
    def test_mandarin_analysis_counts_han_characters_with_utf16_offsets_and_keeps_latin_separate(self):
        text = '我𠮷我 English 书書'
        result = analyze(Analysis(text=text, language='zh-Hant'))
        self.assertEqual(result['method'], 'characters')
        self.assertEqual(set(result['lemmas']), {'我', '𠮷', '书', '書'})
        self.assertEqual(result['tokens'][1]['from'], 1)
        self.assertEqual(result['tokens'][1]['to'], 3)
        self.assertEqual(result['tokens'][2]['from'], 3)
        self.assertFalse(any(token['word'] == 'English' for token in result['tokens']))

    def test_mandarin_audio_matches_simplified_speech_against_traditional_text(self):
        result = match_timings(['我', '去', '銀行'], [('我', 0, .2, .9), ('去', .2, .4, .9), ('银行', .4, 1, .9)])
        self.assertEqual(len(result), 3)
        self.assertTrue(all(item is not None for item in result))
        self.assertEqual(result[-1]['end'], 1)

    def test_mixed_audio_requests_segment_language_detection_and_transcription(self):
        class Model:
            def transcribe(self, samples, **options):
                self.options = options
                return [types.SimpleNamespace(words=[speech_word('hello', .1, .4)])], None
        model = Model()
        heard = recognized_words(model, np.ones(16000), 'mul', [], retry=True)
        self.assertEqual(heard[0][0], 'hello')
        self.assertIsNone(model.options['language'])
        self.assertTrue(model.options['multilingual'])
        self.assertEqual(model.options['task'], 'transcribe')
        self.assertFalse(model.options['condition_on_previous_text'])

    def test_accents_and_apostrophes_match_without_confusing_enye(self):
        self.assertEqual(normalized("¿Páramo?"), "paramo")
        self.assertNotEqual(normalized("año"), normalized("ano"))
        self.assertEqual(normalized("don't"), normalized("don’t"))
        model = types.SimpleNamespace(transcribe=lambda *args, **kwargs: (
            [types.SimpleNamespace(words=[speech_word(" don’t", 0.1, 0.6)])], None))
        heard = recognized_words(model, [], "en", ["don't"])
        self.assertEqual(match_timings(["don't"], heard)[0]["start"], 0.1)

    def test_empty_heading_recognition_retries_without_silence_rejection(self):
        class Model:
            def __init__(self):
                self.options = []

            def transcribe(self, *args, **kwargs):
                self.options.append(kwargs)
                words = [] if len(self.options) == 1 else [speech_word(" Tiliches", 0.1, 0.9)]
                return [types.SimpleNamespace(words=words)], None

        model = Model()
        with patch("app.recognizer", return_value=model), patch("app.subprocess.run", return_value=types.SimpleNamespace(stdout=b"\0" * 64000)):
            result = align(Alignment(audio=base64.b64encode(b"audio").decode(), words=["Tiliches"], language="ES_mx"))
        self.assertIsNotNone(result["timings"][0])
        self.assertEqual(len(model.options), 2)
        self.assertEqual(model.options[0]["language"], "es")
        self.assertIsNone(model.options[1]["no_speech_threshold"])
        self.assertIsNone(model.options[1]["initial_prompt"])

    def test_unmatched_numbers_remain_unmatched_and_invalid_times_are_not_returned(self):
        self.assertEqual(match_timings(["42"], [("cuarenta", 0.1, 0.4, 1)]), [None])
        self.assertEqual(match_timings(["uno"], [("uno", float("nan"), 0.4, 1)]), [None])

    def test_rescan_recognizes_fresh_speech_and_rejects_low_confidence_or_silent_matches(self):
        class Model:
            def __init__(self):
                self.options = []

            def transcribe(self, *args, **kwargs):
                self.options.append(kwargs)
                weak = speech_word("dos", .5, .8)
                weak.probability = .3
                return [types.SimpleNamespace(words=[speech_word("uno", .1, .4), weak])], None

        model = Model()
        body = Alignment(audio=base64.b64encode(b"audio").decode(), words=["uno", "dos"], language="es")
        with patch("app.recognizer", return_value=model), patch("app.decode_recording", return_value=np.ones(16000, dtype=np.float32)):
            result = rescan_recording(body)
        self.assertIsNotNone(result["timings"][0])
        self.assertIsNone(result["timings"][1])
        self.assertEqual(model.options[0]["beam_size"], 5)
        self.assertFalse(model.options[0]["vad_filter"])
        self.assertIsNone(model.options[0]["initial_prompt"])
        with patch("app.recognizer", return_value=model), patch("app.decode_recording", return_value=np.zeros(16000, dtype=np.float32)):
            self.assertEqual(rescan_recording(body)["timings"], [None, None])


if __name__ == "__main__":
    unittest.main()
