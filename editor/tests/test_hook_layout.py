import unittest
from PIL import Image

from app import pipeline, server
from app.renderer import H, W, hook_sprite, hook_sprite_for_settings


class HookLayoutTests(unittest.TestCase):
    def test_current_titles_are_larger_and_stay_in_safe_area(self):
        for audience in ('Indian girls', 'snow bunnies', 'ASU sorority girls',
                         'goth mommies', 'freaky gym girls'):
            text = 'Matched with 10,000 ' + audience
            sprite = hook_sprite_for_settings({**pipeline.MATCH_HOOK_TEXT, 'text': text})
            old = hook_sprite(text, 60, int(W * 0.86))
            self.assertGreater(sprite.height, old.height)
            self.assertLessEqual(sprite.width, int(W * 0.86))
            self.assertLessEqual(sprite.height, int(H * 0.22))

    def test_fitted_preview_is_identical_scaled_export_sprite(self):
        settings = {**pipeline.MATCH_HOOK_TEXT, 'text': 'Matched with 10,000 ASU sorority girls'}
        full = hook_sprite_for_settings(settings)
        small = hook_sprite_for_settings(settings, W // 3, H // 3)
        expected = full.resize((round(full.width / 3), round(full.height / 3)), Image.LANCZOS)
        self.assertEqual(small.tobytes(), expected.tobytes())

    def test_unbroken_title_does_not_overflow(self):
        sprite = hook_sprite_for_settings({**pipeline.MATCH_HOOK_TEXT, 'text': 'W' * 60})
        self.assertLessEqual(sprite.width, int(W * 0.86))
        self.assertLessEqual(sprite.height, int(H * 0.22))

    def test_direct_matches_only_change_automatic_opening_placement(self):
        p = {'funnel': {'basis': 'matches'}, 'scenes': [
            {'headScale': 0.52, 'headX': -0.24, 'headY': 0.0},
            {'headScale': 0.52, 'headX': 0.24, 'headY': 0.0}]}
        second = dict(p['scenes'][1])
        server._place_hook_scene(p, {})
        self.assertEqual(tuple(p['scenes'][0][k] for k in ('headScale', 'headX', 'headY')),
                         pipeline.MATCH_HOOK_PLACEMENT)
        self.assertEqual(p['scenes'][1], second)
        p['scenes'][0] = {'headScale': 0.91, 'headX': 0.04, 'headY': -0.03}
        manual = dict(p['scenes'][0])
        server._place_hook_scene(p, {})
        self.assertEqual(p['scenes'][0], manual)


if __name__ == '__main__':
    unittest.main()
