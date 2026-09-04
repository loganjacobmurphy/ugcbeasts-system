import unittest

from app import formats


class TranscriptCorrectionTests(unittest.TestCase):
    def test_thousands_fragments_are_one_caption_without_changing_indices(self):
        words = [{"w": w, "s": i, "e": i + 1} for i, w in enumerate(
            ["10", ",000", "matches.", "7", ",958", "replied."])]
        formats.fix_heard(words)
        self.assertEqual([w["w"] for w in words],
                         ["10,000", "", "matches.", "7,958", "", "replied."])
        self.assertEqual([(w["s"], w["e"]) for w in words], [(i, i+1) for i in range(6)])
        self.assertEqual(formats.fix_heard(words), 0)

    def test_hella_matches_correction_keeps_word_timing(self):
        words = [{"w": "hello", "s": 1.0, "e": 1.2}, {"w": "matches", "s": 1.2, "e": 1.5}]
        formats.fix_heard(words)
        self.assertEqual(words[0], {"w": "hella", "s": 1.0, "e": 1.2})
        ordinary = [{"w": w} for w in "I said hello to her".split()]
        formats.fix_heard(ordinary)
        self.assertEqual(" ".join(w["w"] for w in ordinary), "I said hello to her")

    def test_direct_match_funnel_uses_stats_format(self):
        fid, audience, confidence, _why = formats.classify(
            "I matched with 10,000 Indian girls in the last three months to see "
            "how many would be down to crack. 7,958 responded, with 7,937 saying no, "
            "but 21 saying they might be down. I used Regen for this. In the end "
            "I cracked three. I got hella matches but my approach was not good.",
            campaign_name="Regen (Bounty)",
        )
        self.assertEqual(fid, "f_c60511fc6d")
        self.assertEqual(audience, "a_indians")
        self.assertGreater(confidence, 0.5)

    def test_corrects_roast_app_misheard_as_rose(self):
        words = [{"w": word} for word in "I used Rose for this".split()]
        formats.fix_heard(words, app="Roast")
        self.assertEqual([w["w"] for w in words], "I used Roast for this".split())

    def test_keeps_literal_rose_in_roast_campaign(self):
        words = [{"w": word} for word in "the rose looked good".split()]
        formats.fix_heard(words, app="Roast")
        self.assertEqual([w["w"] for w in words], "the rose looked good".split())

    def test_keeps_rose_for_another_app(self):
        words = [{"w": word} for word in "I used Rose for this".split()]
        formats.fix_heard(words, app="Regen")
        self.assertEqual([w["w"] for w in words], "I used Rose for this".split())

    def test_corrects_regen_app_misheard_as_region_or_regent(self):
        for heard in ("region", "regent"):
            words = [{"w": word} for word in f"I used {heard} for this".split()]
            formats.fix_heard(words, app="Regen")
            self.assertEqual([w["w"] for w in words], "I used Regen for this".split())

    def test_corrects_abg_acronym_misheard_as_avgs(self):
        words = [{"w": word} for word in "gets me tons of AVG's".split()]
        formats.fix_heard(words)
        self.assertEqual([w["w"] for w in words], "gets me tons of ABGs".split())

    def test_corrects_snow_bunny_and_matched_whisper_errors(self):
        words = [{"w": word} for word in "they macked back and the snow money's replied".split()]
        formats.fix_heard(words)
        self.assertEqual(
            [w["w"] for w in words],
            "they matched back and the snow bunnies replied".split(),
        )

    def test_corrects_real_goth_caption_errors(self):
        words = [{"w": word} for word in
                 "I swap to my face with his and received four grippy foot drops".split()]
        formats.fix_heard(words)
        self.assertEqual(
            [w["w"] for w in words if w["w"]],
            "I swapped my face with his and received four grippy foot jobs".split(),
        )

    def test_corrects_swiped_right_phrase_misheard_as_start_to_write(self):
        words = [{"w": word} for word in
                 "So I start to write on 10,000 hotties using Hinge".split()]
        formats.fix_heard(words)
        self.assertEqual(
            [w["w"] for w in words if w["w"]],
            "So I swiped right on 10,000 hotties using Hinge".split(),
        )

    def test_corrects_feet_pictures_misheard_as_feed_pictures(self):
        words = [{"w": word} for word in
                 "how many ASU girl feed pictures I can get".split()]
        formats.fix_heard(words)
        self.assertEqual(
            [w["w"] for w in words],
            "how many ASU girl feet pictures I can get".split(),
        )

    def test_corrects_hinch_and_head_of_a_lot_caption_errors(self):
        words = [{"w": word} for word in
                 "matches on Hinch and a head of a lot more".split()]
        formats.fix_heard(words)
        self.assertEqual(
            [w["w"] for w in words],
            "matches on Hinge and a hell of a lot more".split(),
        )

    def test_asu_girls_selects_asu_sorority_audience(self):
        fid, audience, _confidence, _why = formats.classify(
            "I'm going on a mission to see how many ASU girl feet pictures I can get. "
            "I DM'd a hundred thousand of them. Out of the ones that actually opened "
            "it, fourteen hundred typed something back. Before I tell you how many I "
            "ended up receiving, here is how I got them.",
            campaign_name="Regen (Bounty)",
        )
        self.assertEqual(fid, "f_prove")
        self.assertEqual(audience, "a_asu")

    def test_complete_short_feet_funnel_is_not_mistaken_for_crack_series(self):
        fid, audience, confidence, _why = formats.classify(
            "I'm doing an experiment to see how many goth mommy feet pictures I "
            "can get in the next 30 days. I DM'd 10,000 goth mommies. Out of that "
            "8,520 left me undelivered, but 1,480 opened my message. Then 351 "
            "responded with 269 saying no, but 82 saying yes. So far I've only "
            "received eight photos.",
            campaign_name="Regen (Bounty)",
        )
        self.assertEqual(fid, "f_prove")
        self.assertGreater(confidence, 0.5)

    def test_complete_hinge_feet_funnel_uses_swipe_stats_format(self):
        fid, audience, confidence, _why = formats.classify(
            "I'm doing an experiment to see how many snow bunny feet pictures I "
            "can get. I swiped right on 10,000 snow bunnies on Hinge. 1,550 "
            "matched. Out of the ones who matched, 367 replied. Then 278 said no, "
            "but 89 said yes. So far I've received ten photos.",
            campaign_name="Regen (Bounty)",
        )
        self.assertEqual(fid, "f_c60511fc6d")
        self.assertEqual(audience, "a_snowbunnies")
        self.assertGreater(confidence, 0.5)

    def test_complete_hinge_swipe_funnel_beats_crack_series_wording(self):
        fid, audience, confidence, why = formats.classify(
            "I swiped right on 10k Indian girls using Hinge to see how many would "
            "be down to crack. Out of those, 1730 actually matched with me. Out "
            "of the ones that matched, 405 actually said something to me. Then "
            "307 said no, but 98 were interested. In the end I ended up cracking "
            "7 Indian girls.",
            campaign_name="Regen (Bounty)",
        )
        self.assertEqual(fid, "f_c60511fc6d")
        self.assertEqual(audience, "a_indians")
        self.assertGreater(confidence, 0.5)
        self.assertIn("complete swipe match reply answer result funnel", why)

    def test_thirty_day_hinge_feet_funnel_uses_feet_stats_format(self):
        fid, audience, confidence, _why = formats.classify(
            "I'm doing a challenge to see how many foot jobs I can get from goth "
            "mommies using Hinge in the next 30 days. Out of 10,000 swipes, 1,480 "
            "matched. Out of the ones who matched, 351 replied. 269 said no, but "
            "82 said they might be down. So far I've only received four.",
            campaign_name="Regen (Bounty)",
        )
        self.assertEqual(fid, "f_feet_30day")
        self.assertEqual(audience, "a_gothmums")
        self.assertGreater(confidence, 0.5)


if __name__ == "__main__":
    unittest.main()
