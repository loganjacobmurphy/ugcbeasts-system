import unittest

from app.pipeline import Timeline


class TimelineTests(unittest.TestCase):
    def test_word_mapping_keeps_mid_insert_and_resumed_audio_in_output_order(self):
        segments = [
            [0.0, 3.0, 0, 4],
            [10.0, 12.0, 5, 6],
            [2.9, 5.0, 7, 10],
        ]
        timeline = Timeline(segments)

        inserted = timeline.word_to_out(5, 10.5)
        resumed = timeline.word_to_out(7, 3.0)

        self.assertAlmostEqual(inserted, 3.5)
        self.assertAlmostEqual(resumed, 5.1)
        self.assertLess(inserted, resumed)


if __name__ == "__main__":
    unittest.main()
