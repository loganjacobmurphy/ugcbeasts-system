import unittest

from app import stats


class FunnelParserTests(unittest.TestCase):
    def test_direct_matches_start_at_matches_not_swipes(self):
        text = (
            "I matched with 10,000 Indian girls in the last three months to see "
            "how many would be down to crack. Out of all of those, 7,958 responded, "
            "with 7,937 saying no, but 21 saying they might be down. But before I "
            "tell you how many I actually cracked, let me show you how I got them. "
            "I took a male model's photo and swapped my face with his. I used Regen "
            "for this. In the end, I've only ended up cracking three. I did get "
            "hella matches, but I just don't think my approach was very good."
        )
        fun = stats.from_transcript(text)
        self.assertEqual(fun, {
            "basis": "matches", "sent": 10000, "opened": 10000, "notOpened": 0,
            "responded": 7958, "ignored": 2042, "saidNo": 7937, "saidYes": 21,
            "cracked": 3,
        })
        self.assertEqual([name for name, image in stats.render_all(fun)],
                         ["who replied", "who said yes", "the result"])

    def test_ignores_malformed_decimal_rate_and_uses_valid_open_rate(self):
        text = (
            "I DM'd 20,000 WNBA players. Out of that 12,075.65% left me on "
            "delivered, but 24.35% actually opened my message. After that 341 "
            "responded. Then 318 said no, but 23 were down to crack. I ended up "
            "only cracking two so far."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 20000,
                "opened": 4870,
                "notOpened": 15130,
                "responded": 341,
                "ignored": 4529,
                "saidNo": 318,
                "saidYes": 23,
                "cracked": 2,
            },
        )

    def test_reads_stray_percent_on_whole_counts(self):
        text = (
            "I messaged 100,000 people. 86% never opened it, but 14% opened my "
            "message. 1,368% actually responded. 1,200 said no, but 168% said "
            "they were down. I have only cracked free so far."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 100000,
                "opened": 14000,
                "notOpened": 86000,
                "responded": 1368,
                "ignored": 12632,
                "saidNo": 1200,
                "saidYes": 168,
                "cracked": 3,
            },
        )

    def test_bare_decimal_can_complete_the_split(self):
        text = (
            "I messaged 50k people. 87.6% left me on delivered, but 12.4 actually "
            "opened my message. 400 replied. 360 said no, but 40 said yes. I only "
            "cracked four so far."
        )
        self.assertEqual(stats.from_transcript(text)["opened"], 6200)

    def test_reads_full_funnel_spoken_as_number_words(self):
        text = (
            "I DM'd a hundred thousand ASU girls. Out of that hundred thousand, "
            "sixteen thousand, two hundred and thirty actually opened my message, "
            "which means eighty three thousand, seven hundred and seventy left me "
            "undelivered. Out of the ones that opened it, one thousand four hundred "
            "and fifty eight typed something back. Then 1332 said no, but 126 said "
            "they would be down. I've only ended up receiving 7 feet pictures."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 100000,
                "opened": 16230,
                "notOpened": 83770,
                "responded": 1458,
                "ignored": 14772,
                "saidNo": 1332,
                "saidYes": 126,
                "cracked": 7,
            },
        )

    def test_result_sent_does_not_replace_original_send(self):
        text = (
            "I asked 100,000 PAWGs for feet pics. Only 13,420 opened my message. "
            "Then 1,072 responded. 986 said no, but 86 said they actually would be "
            "down. We ended up getting sent four pictures so far."
        )
        self.assertEqual(stats.from_transcript(text)["sent"], 100000)
        self.assertEqual(stats.from_transcript(text)["cracked"], 4)

    def test_reads_might_be_down_and_said_straight_up_no(self):
        text = (
            "I DMed 100k big white girls. Out of that 100k, only 13,110 opened "
            "my message. Out of the ones that opened it, 967 typed something "
            "back. Then 889 said straight up no but 78 said they might be down. "
            "So far I've only ended up getting four."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 100000,
                "opened": 13110,
                "notOpened": 86890,
                "responded": 967,
                "ignored": 12143,
                "saidNo": 889,
                "saidYes": 78,
                "cracked": 4,
            },
        )

    def test_reads_end_up_getting_with_result_homophone(self):
        text = (
            "I DMed 100k strippers. Out of that 100k, 12,340 opened the message. "
            "Out of the ones that opened it, 874 responded. Then 803 instantly "
            "said no, but 71 said they would be down. So far I've only end up "
            "getting free photos."
        )
        self.assertEqual(stats.from_transcript(text)["cracked"], 3)

    def test_reads_sent_total_from_out_of_that_after_send_is_cut(self):
        text = (
            "I asked every single one for a picture. Out of that 100k, only "
            "13,110 opened my message. Out of the ones that opened it, 967 typed "
            "something back. Then 889 said straight up no but 78 said they might "
            "be down. I've only ended up getting four."
        )
        self.assertEqual(stats.from_transcript(text)["sent"], 100000)

    def test_reads_so_far_received_without_only(self):
        text = (
            "I DM'd 10,000 femboys to see if any would send feet pictures. "
            "8,390 left me undelivered, but 1,610 actually opened my message. "
            "Then 382 replied, 291 said no, and 91 said they were down. "
            "So far I've received nine photos, but we have the rest of the list."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 10000,
                "opened": 1610,
                "notOpened": 8390,
                "responded": 382,
                "ignored": 1228,
                "saidNo": 291,
                "saidYes": 91,
                "cracked": 9,
            },
        )

    def test_reads_real_whisper_variants_from_short_batch(self):
        text = (
            "I DM 10,000 freaky gym girls asking for their feet. Out of that "
            "10,000, 8,830 left me undelivered, but 1,170 opened my message, then "
            "284 raised something back, with 218 saying no, but 66 saying they "
            "might be down. So far I've only received five photos."
        )
        self.assertEqual(stats.from_transcript(text)["responded"], 284)
        self.assertEqual(stats.from_transcript(text)["cracked"], 5)

    def test_reads_might_actually_be_down(self):
        text = (
            "I messaged 10,000 PAWGs. Only 1,550 actually opened my message, with "
            "367 typing something back, 278 saying no, but 89 saying it might "
            "actually be down. So far I've only received 10 photos."
        )
        self.assertEqual(stats.from_transcript(text)["saidYes"], 89)

    def test_reads_complete_hinge_swipe_funnel(self):
        text = (
            "I swiped right on 10,000 snow bunnies on Hinge. Out of those, "
            "8,450 did not match with me, but 1,550 matched. Out of the ones who "
            "matched, 367 replied. Then 278 said no, but 89 said yes. So far "
            "I've received 10 photos."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 10000,
                "opened": 1550,
                "notOpened": 8450,
                "responded": 367,
                "ignored": 1183,
                "saidNo": 278,
                "saidYes": 89,
                "cracked": 10,
            },
        )

    def test_reads_only_had_footjobs_payoff_from_hinge_upload(self):
        text = (
            "I swiped right on 10,000 freaky gym girls using Hinge. Out of all "
            "of those swipes, 2,426 matched back with me, then 1,887 replied, "
            "then 1,863 said no, but 24 said they might actually be down. In "
            "the end, I've only had three foot jobs, but you have to wish me luck."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 10000,
                "opened": 2426,
                "notOpened": 7574,
                "responded": 1887,
                "ignored": 539,
                "saidNo": 1863,
                "saidYes": 24,
                "cracked": 3,
            },
        )

    def test_reads_had_count_saying_they_were_down(self):
        text = (
            "I swiped right on 10,000 MILFs using Hinge. Out of those 2,672 "
            "matched with me, then 2,116 replied with 2,092 saying straight up "
            "no, but I had 24 saying they were down. In the end I've only "
            "actually cracked two."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 10000,
                "opened": 2672,
                "notOpened": 7328,
                "responded": 2116,
                "ignored": 556,
                "saidNo": 2092,
                "saidYes": 24,
                "cracked": 2,
            },
        )

    def test_all_of_the_profiles_uses_current_10k_hinge_total(self):
        text = (
            "I swiped right on all of the ASU sorority girls using Hinge. Out "
            "of those, 2,514 matched with me, then 1,971 replied, with 1,950 "
            "saying no, but 21 saying they might be down. In the end I only "
            "ended up cracking three."
        )
        self.assertEqual(stats.from_transcript(text)["sent"], 10000)
        self.assertEqual(stats.from_transcript(text)["saidYes"], 21)

    def test_hinge_match_percentages_must_add_up(self):
        text = (
            "I swiped right on 10,000 profiles on Hinge. 81% did not match, but "
            "14% matched. Then 200 replied."
        )
        self.assertIn("95%", stats.percentages_disagree(text))

    def test_reads_indian_hinge_wording_from_upload(self):
        text = (
            "I swiped right on 10k Indian girls using Hinge. Out of those, only "
            "1730 actually matched with me. Out of the ones that matched, only "
            "405 actually said something to me, then 307 said no, but 98 were "
            "interested. In the end I've ended up cracking 7 Indian girls."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 10000,
                "opened": 1730,
                "notOpened": 8270,
                "responded": 405,
                "ignored": 1325,
                "saidNo": 307,
                "saidYes": 98,
                "cracked": 7,
            },
        )

    def test_reads_macked_back_whisper_variant(self):
        text = (
            "I swiped right on 10,000 snow bunnies. Out of that 10,000, 5,843 "
            "actually macked back. Out of the ones that matched, 2,417 replied. "
            "Then 1,672 said no, and 745 said they might be down. So far I've "
            "cracked only seven."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 10000,
                "opened": 5843,
                "notOpened": 4157,
                "responded": 2417,
                "ignored": 3426,
                "saidNo": 1672,
                "saidYes": 745,
                "cracked": 7,
            },
        )

    def test_reads_swipes_denominator_from_goth_upload(self):
        text = (
            "I'm doing a challenge using Hinge. Out of 10,000 swipes, 1,480 "
            "matched with me and the rest didn't. Out of the ones who matched, "
            "351 replied, 269 said no, but 82 said they might be down. So far "
            "I've only received four."
        )
        self.assertEqual(stats.from_transcript(text)["sent"], 10000)
        self.assertEqual(stats.from_transcript(text)["opened"], 1480)

    def test_reads_managed_to_receive_payoff(self):
        text = (
            "I swiped right on 10,000 freaky gym girls. 1,265 matched. Out of "
            "the matches, 306 replied, then 238 said no, but 68 said yes. So far "
            "I've managed to receive two grippy foot jobs."
        )
        self.assertEqual(stats.from_transcript(text)["cracked"], 2)

    def test_reads_lost_virginity_payoff(self):
        text = (
            "I swiped right on 10,000 hotties using Hinge. Out of those 2,463 "
            "matched with me, then 1,958 replied with 1,937 saying no, but 21 "
            "saying they might be down. In the end I only actually lost my "
            "virginity three times."
        )
        self.assertEqual(
            stats.from_transcript(text),
            {
                "sent": 10000,
                "opened": 2463,
                "notOpened": 7537,
                "responded": 1958,
                "ignored": 505,
                "saidNo": 1937,
                "saidYes": 21,
                "cracked": 3,
            },
        )

    def test_blank_corrected_token_does_not_hide_swiped_right(self):
        text = (
            "I swiped  right on 10,000 ASU girls. 2,618 matched, then 2,083 "
            "replied with 2,061 saying no, but 22 said they might be down. "
            "In the end I only received three pictures."
        )
        self.assertEqual(stats.from_transcript(text)["sent"], 10000)


if __name__ == "__main__":
    unittest.main()
