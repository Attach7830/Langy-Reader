import base64
import types
import unittest
from unittest.mock import patch

from app import Alignment, align, match_timings, normalized, recognized_words


def speech_word(word, start, end):
    return types.SimpleNamespace(word=word, start=start, end=end, probability=0.9)


class AlignmentTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
