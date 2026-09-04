import unittest
from unittest.mock import patch

from app import pipeline, server


def phrase_start(words, phrase):
    want = phrase.split()
    for i in range(len(words) - len(want) + 1):
        if [w["w"] for w in words[i:i + len(want)]] == want:
            return i
    raise AssertionError("missing phrase: " + phrase)


class FunnelSceneTests(unittest.TestCase):
    def test_direct_match_funnel_opens_on_inbox_and_closes_on_chat(self):
        from app import stats
        text = (
            "I matched with 10,000 Indian girls in the last three months to see "
            "how many would be down to crack. Out of all of those, 7,958 responded, "
            "with 7,937 saying no, but 21 saying they might be down. But before I "
            "tell you how many I actually cracked, let me show you how I got them. "
            "I took a male model's photo and swapped my face with his. I used Regen "
            "for this. In the end, I've only ended up cracking three. I did get "
            "hella matches, but I just don't think my approach was very good."
        )
        words = [{"w": w} for w in text.split()]
        p = {"id": "test", "format": "f_c60511fc6d", "app": "regen", "words": words,
             "breaks": [0], "scenes": pipeline.scenes_from_breaks(words, [0]),
             "funnel": stats.from_transcript(text)}
        server._funnel_scenes(p)
        server._cta_scenes(p)
        self.assertNotIn(1, p["breaks"])
        self.assertIn(phrase_start(words, "Out of all"), p["breaks"])
        self.assertIn(phrase_start(words, "I did get"), p["breaks"])
        self.assertIn(phrase_start(words, "I used Regen"), p["breaks"])
        self.assertIn(phrase_start(words, "and swapped"), p["breaks"])
        app_assets = [{"id": "inbox", "collection": "hinge inbox", "added": 1}]
        chat = {"id": "chat", "collection": "funnel test", "statsCard": "hinge swipes"}
        with patch.object(server, "_app_pool", return_value=app_assets), \
                patch.object(server.store, "get_asset", return_value=None), \
                patch.object(server.store, "load_library", return_value={"items": [chat]}):
            server._place_app_shots(p)
        self.assertEqual(p["scenes"][0]["asset"], "inbox")
        self.assertEqual(p["scenes"][-1]["asset"], "chat")

    def test_direct_match_bookends_preserve_stats_timing_and_personalized_inbox(self):
        import copy
        words = [{"w": w} for w in (
            "I matched with 10000 girls. 8000 replied. 7980 said no. "
            "I used Regen. I cracked three. I got hella matches but my approach was bad."
        ).split()]
        starts = [0, 5, 7, 11, 14, 17]
        p = {"id": "test", "funnel": {"basis": "matches"}, "words": words,
             "hingeInboxAsset": "personalized", "scenes": pipeline.scenes_from_breaks(words, starts)}
        for i, sc in enumerate(p["scenes"]):
            sc["asset"] = "original%d" % i
        before = copy.deepcopy(p["scenes"])
        chat = {"id": "chat", "collection": "funnel test", "statsCard": "hinge swipes"}
        with patch.object(server.store, "get_asset", return_value={"id": "personalized"}), \
                patch.object(server.store, "load_library", return_value={"items": [chat]}):
            server._place_direct_match_bookends(p)
            once = copy.deepcopy(p["scenes"])
            server._place_direct_match_bookends(p)
        self.assertEqual(p["scenes"], once)
        self.assertEqual(p["scenes"][1:-1], before[1:-1])
        self.assertEqual([(s["start"], s["end"]) for s in p["scenes"]],
                         [(s["start"], s["end"]) for s in before])
        self.assertEqual(p["scenes"][0]["asset"], "personalized")
        self.assertEqual(p["scenes"][-1]["asset"], "chat")

    def test_direct_match_cards_do_not_shift_stats_into_cta_or_closing(self):
        from app import stats
        from PIL import Image
        text = (
            "I matched with 10,000 snow bunnies on Hinge and asked if they were "
            "down to crack. 7,843 replied. 7,821 said no, but 22 said they were down. "
            "But before I tell you how many I actually cracked, let me show you "
            "how I got them. I took a male model's photo and swapped my face with "
            "his. I used Regen for this. In the end I cracked three. I got hella "
            "matches but my approach was not good for conversion."
        )
        words = [{"w": w} for w in text.split()]
        p = {"id": "test", "format": "f_c60511fc6d", "app": "regen",
             "audience": "a_snowbunnies", "words": words, "breaks": [0],
             "scenes": pipeline.scenes_from_breaks(words, [0]),
             "funnel": stats.from_transcript(text)}
        server._funnel_scenes(p)
        server._cta_scenes(p)
        photo = {"id": "photo", "folder": "people", "type": "image",
                 "file": "fake.jpg", "collection": "snow bunnies"}
        for sc in p["scenes"]:
            sc["asset"] = "photo"
        saved = {"photo": photo}
        def add(folder, filename, content=None, name=None, meta=None):
            item = {"id": name, "folder": folder, "file": filename, **meta}
            saved[name] = item
            return item
        tiny = Image.new("RGB", (2, 2))
        with patch.object(server.store, "load_library", return_value={"items": [photo]}), \
                patch.object(server.store, "get_asset", side_effect=saved.get), \
                patch.object(server.store, "add_library_file", side_effect=add), \
                patch.object(stats, "load_faces"), \
                patch.object(stats, "hinge_swipes", return_value=tiny), \
                patch.object(stats, "render_all", return_value=[(n, tiny) for n in
                             ("who replied", "who said yes", "the result")]), \
                patch.object(server, "_place_app_shots"), \
                patch.object(server, "_fill_gaps"):
            server._apply_stats_cards(p)
        self.assertEqual([s["asset"] for s in p["scenes"]], [
            "hinge swipes", "who replied", "who said yes", "photo", "photo",
            "photo", "photo", "the result", "photo",
        ])

    def test_hinge_opener_matches_the_spoken_challenge(self):
        self.assertEqual(
            server._hinge_opener("how many ASU girl feet pictures I can get"),
            "Yo, can you send me a feet pic?",
        )
        self.assertEqual(
            server._hinge_opener("how many foot jobs I can receive"),
            "Yo, can I have a footjob?",
        )
        self.assertEqual(
            server._hinge_opener("how many times I can lose my virginity"),
            "Yo, help me lose it?",
        )
        self.assertEqual(
            server._hinge_opener("how many snow bunnies I can crack"),
            "Yo, can I crack?",
        )

    def test_hinge_in_hook_keeps_audience_photo_and_present_swap_gets_result(self):
        text = (
            "I swiped right on 10,000 Indian girls using Hinge. "
            "I take a male model's photo. And swap my face with his."
        )
        words = [{"w": word} for word in text.split()]
        breaks = [0, phrase_start(words, "I take a"), phrase_start(words, "And swap")]
        p = {
            "format": "f_c60511fc6d", "app": "regen", "words": words,
            "breaks": breaks,
            "scenes": pipeline.scenes_from_breaks(words, breaks),
        }
        for i, sc in enumerate(p["scenes"]):
            sc["asset"] = "photo%d" % i
        app_assets = [
            {"id": "generated", "name": "generated photo desert"},
            {"id": "result", "name": "regen result nyc"},
            {"id": "app", "name": "regen app screen 2"},
        ]

        with patch.object(server, "_app_pool", return_value=app_assets), \
                patch.object(server.store, "get_asset", side_effect=lambda aid: {"id": aid}):
            server._place_app_shots(p)

        self.assertEqual(p["scenes"][0]["asset"], "photo0")
        self.assertEqual(p["scenes"][1]["asset"], "generated")
        self.assertEqual(p["scenes"][2]["asset"], "result")

    def test_cta_uses_exact_library_tags_before_fuzzy_names(self):
        text = (
            "I took a male model's photo. I swapped my face with his. "
            "I used Regen for this."
        )
        words = [{"w": word} for word in text.split()]
        breaks = [0, phrase_start(words, "I swapped"), phrase_start(words, "I used")]
        p = {
            "format": "f_c60511fc6d", "app": "regen", "words": words,
            "breaks": breaks,
            "scenes": pipeline.scenes_from_breaks(words, breaks),
        }
        for i, sc in enumerate(p["scenes"]):
            sc["asset"] = "photo%d" % i
        app_assets = [
            {"id": "old_model", "name": "generated model photo"},
            {"id": "old_result", "name": "regen result nyc"},
            {"id": "old_app", "name": "regen app screen 2"},
            {"id": "og", "name": "chosen original", "collection": "og", "added": 1},
            {"id": "swap", "name": "chosen swap", "collection": "result", "added": 2},
            {"id": "regen", "name": "chosen app", "collection": "regen", "added": 3},
        ]

        with patch.object(server, "_app_pool", return_value=app_assets), \
                patch.object(server.store, "get_asset", side_effect=lambda aid: {"id": aid}):
            server._place_app_shots(p)

        self.assertEqual([sc["asset"] for sc in p["scenes"]], ["og", "swap", "regen"])

    def test_hook_starting_with_swiped_right_does_not_make_one_word_scene(self):
        text = (
            "I swiped right on 10,000 snow bunnies to see how many would crack. "
            "Out of that 10,000, 5,843 actually macked back. Out of the ones that "
            "matched, 2,417 replied. Then 1,672 said no, and 745 were down. "
            "Before I reveal how many, I took a male model photo. So far I cracked 7."
        )
        words = [{"w": word} for word in text.split()]
        p = {
            "format": "f_c60511fc6d",
            "app": "regen",
            "words": words,
            "breaks": [0],
            "scenes": pipeline.scenes_from_breaks(words, [0]),
            "funnel": {
                "sent": 10000, "opened": 5843, "notOpened": 4157,
                "responded": 2417, "ignored": 3426, "saidNo": 1672,
                "saidYes": 745, "cracked": 7,
            },
        }

        server._funnel_scenes(p)

        self.assertNotIn(1, p["breaks"])
        self.assertIn(phrase_start(words, "Out of that"), p["breaks"])

    def test_blank_correction_slot_does_not_hide_separate_swipe_scene(self):
        text = (
            "I am going on a mission for 30 days so I swiped right on 10,000 "
            "ASU girls. Out of those 2,618 matched. Then 2,083 replied. "
            "2,061 said no but 22 were down. Before I tell you how many, "
            "I used Regen for this. In the end I received three."
        )
        words = [{"w": word} for word in text.split()]
        swipe = phrase_start(words, "I swiped right")
        words.insert(swipe + 2, {"w": ""})
        p = {
            "format": "f_feet_30day", "app": "regen", "words": words,
            "breaks": [0], "scenes": pipeline.scenes_from_breaks(words, [0]),
            "funnel": {
                "sent": 10000, "opened": 2618, "notOpened": 7382,
                "responded": 2083, "ignored": 535, "saidNo": 2061,
                "saidYes": 22, "cracked": 3,
            },
        }

        server._funnel_scenes(p)

        self.assertIn(swipe - 1, p["breaks"])

    def test_teaser_ended_up_getting_is_not_the_result_scene(self):
        text = (
            "I swiped right on 10,000 gym girls. 1,265 matched. 306 replied. "
            "238 said no but 68 said yes. Before I reveal how many I ended up "
            "getting, I did what I use on dating apps. I took a male model photo "
            "and swapped my face with his. This method already gets me ABGs. "
            "So far I've managed to receive two."
        )
        words = [{"w": word} for word in text.split()]
        teaser = phrase_start(words, "ended up getting,")
        result = phrase_start(words, "So far I've")
        p = {
            "format": "f_c60511fc6d", "app": "regen", "words": words,
            "breaks": [0, teaser], "funnelAnchors": [0, teaser],
            "scenes": pipeline.scenes_from_breaks(words, [0, teaser]),
            "funnel": {
                "sent": 10000, "opened": 1265, "notOpened": 8735,
                "responded": 306, "ignored": 959, "saidNo": 238,
                "saidYes": 68, "cracked": 2,
            },
        }

        server._funnel_scenes(p)

        self.assertNotIn(teaser, p["breaks"])
        self.assertIn(result, p["breaks"])

    def test_hinge_funnel_puts_every_stats_stage_on_its_own_scene(self):
        text = (
            "To prove how much I love snow bunnies, I went looking on Hinge. "
            "I swiped right on 10,000 snow bunnies on Hinge. Out of those, "
            "8,450 did not match, but 1,550 matched. Out of the ones who matched, "
            "367 replied. Then 278 said no, but 89 said yes. Before I tell you "
            "how many, I took a male model's photo and swapped my face with his. "
            "I used Regen for this. So far I've received 10 photos."
        )
        words = [{"w": word} for word in text.split()]
        p = {
            "format": "f_prove",
            "app": "regen",
            "words": words,
            "breaks": [0],
            "scenes": pipeline.scenes_from_breaks(words, [0]),
            "funnel": {
                "sent": 10000,
                "opened": 1550,
                "notOpened": 8450,
                "responded": 367,
                "ignored": 1183,
                "saidNo": 278,
                "saidYes": 89,
                "cracked": 10,
            },
        }

        server._funnel_scenes(p)
        server._cta_scenes(p)

        self.assertIn(phrase_start(words, "I swiped right"), p["breaks"])
        self.assertIn(phrase_start(words, "Out of those,"), p["breaks"])
        self.assertIn(phrase_start(words, "Out of the ones"), p["breaks"])
        self.assertIn(phrase_start(words, "Then 278 said"), p["breaks"])
        self.assertIn(phrase_start(words, "Before I tell"), p["breaks"])
        self.assertIn(phrase_start(words, "I used Regen"), p["breaks"])
        self.assertIn(phrase_start(words, "So far I've"), p["breaks"])

    def test_answer_card_starts_on_no_and_method_gets_own_scene(self):
        text = (
            "I'm going on a mission for 30 days. So I DMed about 10,000 of them "
            "to see how many would send me some. Out of that 10,000, 8,740 left "
            "me undelivered and only 1,260 actually opened my message. Then just "
            "296 actually responded. 227 said no, but 69 actually said they would "
            "be down the same way I do on my dating apps. I took a male models "
            "photo and talked to my face with his using a Regen. So far I've only "
            "received seven photos."
        )
        words = [{"w": word} for word in text.split()]
        starts = [
            0,
            phrase_start(words, "So I DMed"),
            phrase_start(words, "Out of that"),
            phrase_start(words, "Then just"),
            phrase_start(words, "227 said no,"),
            phrase_start(words, "but 69"),
            phrase_start(words, "I took a male"),
            phrase_start(words, "So far I've"),
        ]
        p = {
            "format": "f_prove",
            "app": "regen",
            "words": words,
            "breaks": starts,
            "scenes": pipeline.scenes_from_breaks(words, starts),
            "funnel": {
                "sent": 10000,
                "opened": 1260,
                "notOpened": 8740,
                "responded": 296,
                "ignored": 964,
                "saidNo": 227,
                "saidYes": 69,
                "cracked": 7,
            },
        }

        no_line = phrase_start(words, "227 said no,")
        yes_line = phrase_start(words, "but 69")
        model_line = phrase_start(words, "I took a male")
        swap_line = phrase_start(words, "and talked to my face")
        app_line = phrase_start(words, "using a Regen.")

        server._funnel_scenes(p)
        server._cta_scenes(p)

        self.assertIn(no_line, p["breaks"])
        self.assertNotIn(yes_line, p["breaks"])
        self.assertIn(model_line, p["breaks"])
        self.assertIn(swap_line, p["breaks"])
        self.assertIn(app_line, p["breaks"])

    def test_cta_split_keeps_short_reply_step_and_bare_dm_send(self):
        text = (
            "I'm going on a mission to get feet pictures. So I DM 10,000 femboys. "
            "8,390 left me undelivered, but 1,610 actually opened my message. Then "
            "382 replied, 291 said no, and 91 said they were down. I took a male "
            "model's photo and swapped my face with his. I used Regen for this. "
            "So far I've received nine photos."
        )
        words = [{"w": word} for word in text.split()]
        send_line = phrase_start(words, "So I DM")
        split_line = phrase_start(words, "8,390 left")
        reply_line = phrase_start(words, "Then 382 replied,")
        answer_line = phrase_start(words, "291 said no,")
        model_line = phrase_start(words, "I took a male")
        app_line = phrase_start(words, "I used Regen")
        result_line = phrase_start(words, "So far I've")
        starts = [0, split_line, answer_line, model_line, app_line, result_line]
        p = {
            "format": "f_prove",
            "app": "regen",
            "words": words,
            "breaks": starts,
            "scenes": pipeline.scenes_from_breaks(words, starts),
            "funnel": {
                "sent": 10000,
                "opened": 1610,
                "notOpened": 8390,
                "responded": 382,
                "ignored": 1228,
                "saidNo": 291,
                "saidYes": 91,
                "cracked": 9,
            },
        }

        server._funnel_scenes(p)
        server._cta_scenes(p)

        self.assertIn(send_line, p["breaks"])
        self.assertIn(reply_line, p["breaks"])
        self.assertIn(answer_line, p["breaks"])

    def test_method_opener_does_not_stay_on_answer_card(self):
        text = (
            "I am doing an experiment. So I DMed 10,000 goth mommies. Out of that "
            "8,520 left me undelivered but 1,480 opened my message. Then 351 "
            "responded with 269 saying no but 82 saying yes. And I used the same "
            "method I use on dating apps. So I took a male models photo and swapped "
            "my face with his. I used Regen for this. So far I only received eight."
        )
        words = [{"w": word} for word in text.split()]
        method_line = phrase_start(words, "And I used the")
        starts = [
            0,
            phrase_start(words, "So I DMed"),
            phrase_start(words, "Out of that"),
            phrase_start(words, "Then 351"),
            phrase_start(words, "269 saying no"),
            phrase_start(words, "So I took"),
            phrase_start(words, "I used Regen"),
            phrase_start(words, "So far I"),
        ]
        p = {
            "format": "f_prove",
            "app": "regen",
            "words": words,
            "breaks": starts,
            "scenes": pipeline.scenes_from_breaks(words, starts),
            "funnel": {
                "sent": 10000,
                "opened": 1480,
                "notOpened": 8520,
                "responded": 351,
                "ignored": 1129,
                "saidNo": 269,
                "saidYes": 82,
                "cracked": 8,
            },
        }

        server._funnel_scenes(p)
        server._cta_scenes(p)

        self.assertIn(method_line, p["breaks"])

    def test_present_tense_app_and_match_proof_get_separate_scenes(self):
        text = (
            "To do this I take a male model's photo and swap my face onto his. "
            "I use Regen for this. This also gets me matches with ABGs."
        )
        words = [{"w": word} for word in text.split()]
        p = {
            "format": "f_prove",
            "app": "regen",
            "words": words,
            "breaks": [0],
            "scenes": pipeline.scenes_from_breaks(words, [0]),
        }

        server._cta_scenes(p)

        self.assertIn(phrase_start(words, "and swap my"), p["breaks"])
        self.assertIn(phrase_start(words, "I use Regen"), p["breaks"])
        self.assertIn(phrase_start(words, "This also gets"), p["breaks"])

    def test_pause_does_not_split_present_tense_swap_mid_sentence(self):
        text = (
            "I take a male model's photo and swap my face with theirs with AI. "
            "This also gets me matches with ABGs."
        )
        words = [{"w": word} for word in text.split()]
        model = phrase_start(words, "I take a")
        swap = phrase_start(words, "and swap")
        continuation = phrase_start(words, "with theirs")
        proof = phrase_start(words, "This also")
        breaks = [model, swap, continuation, proof]
        p = {
            "format": "f_c60511fc6d", "app": "regen", "words": words,
            "breaks": breaks,
            "scenes": pipeline.scenes_from_breaks(words, breaks),
        }

        server._cta_scenes(p)

        self.assertIn(swap, p["breaks"])
        self.assertNotIn(continuation, p["breaks"])
        self.assertIn(proof, p["breaks"])

    def test_proof_after_present_tense_app_splits_on_and_i_know(self):
        text = (
            "I take a male model's photo and swap my face with his. I use Regen "
            "for this and I know this method works because it gets ABG matches."
        )
        words = [{"w": word} for word in text.split()]
        p = {
            "format": "f_prove",
            "app": "regen",
            "words": words,
            "breaks": [0],
            "scenes": pipeline.scenes_from_breaks(words, [0]),
        }

        server._cta_scenes(p)

        self.assertIn(phrase_start(words, "I use Regen"), p["breaks"])
        self.assertIn(phrase_start(words, "and I know"), p["breaks"])


if __name__ == "__main__":
    unittest.main()
