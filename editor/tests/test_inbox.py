import copy
import os
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from app import inbox, server


class InboxTemplateTests(unittest.TestCase):
    def test_only_profile_slots_change_and_all_five_are_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            template = os.path.join(directory, "template.png")
            photo = os.path.join(directory, "photo.png")
            rng = np.random.default_rng(8)
            original = rng.integers(225, 256, (2622, 1206, 3), dtype=np.uint8)
            Image.fromarray(original).save(template)
            Image.new("RGB", (300, 450), (90, 40, 160)).save(photo)
            profiles = [{"name": name, "path": photo} for name in
                        ["Madison", "Kenzie", "Blair", "Taylor", "Peyton"]]
            result = np.asarray(inbox.render(template, profiles))
            changed = np.any(original != result, axis=2)
            allowed = np.zeros(changed.shape, dtype=bool)
            for x1, y1, x2, y2 in inbox.AVATAR_BOXES + inbox.NAME_BOXES:
                allowed[y1:y2, x1:x2] = True
                self.assertTrue(changed[y1:y2, x1:x2].any())
            self.assertFalse(changed[~allowed].any())
            self.assertEqual(result.shape, original.shape)

    def test_wrong_template_size_and_incomplete_profiles_are_rejected(self):
        with self.assertRaises(ValueError):
            inbox.render("unused", [])
        with tempfile.TemporaryDirectory() as directory:
            template = os.path.join(directory, "template.png")
            Image.new("RGB", (20, 20)).save(template)
            with self.assertRaises(ValueError):
                inbox.render(template, [{"name": "Test", "path": "unused"}] * 5)

    def test_bookend_personalization_is_pinned_and_does_not_touch_other_scenes(self):
        p = {"id": "test", "funnel": {"basis": "matches"},
             "words": [{"w": "I matched"}, {"w": "stats"}, {"w": "my approach"}],
             "scenes": [{"start": i, "end": i, "asset": str(i), "headScale": 0.78}
                        for i in range(3)]}
        before = copy.deepcopy(p)
        template = {"id": inbox.TEMPLATE_ID, "collection": "hinge inbox"}
        personalized = {"id": "personalized"}
        with patch.object(server, "_app_pool", return_value=[template]), \
                patch.object(server.store, "get_asset", side_effect=lambda aid: personalized if aid == "personalized" else None), \
                patch.object(server.store, "load_library", return_value={"items": []}), \
                patch.object(inbox, "create_asset", return_value=personalized) as create:
            server._place_direct_match_bookends(p)
            server._place_direct_match_bookends(p)
        create.assert_called_once()
        self.assertEqual(p["hingeInboxAsset"], "personalized")
        self.assertEqual(p["scenes"][0]["asset"], "personalized")
        self.assertEqual(p["scenes"][0]["headScale"], 0.78)
        self.assertEqual(p["scenes"][1:], before["scenes"][1:])


if __name__ == "__main__":
    unittest.main()
