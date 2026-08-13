from __future__ import annotations

import unittest

from paper_agent.paper_filters import is_excluded_publication


class PaperFilterTests(unittest.TestCase):
    def test_excludes_corrections_and_retractions(self) -> None:
        self.assertTrue(is_excluded_publication("Author Correction: A paper"))
        self.assertTrue(is_excluded_publication("Retraction Note: A paper"))

    def test_excludes_conference_abstracts_and_nature_news(self) -> None:
        self.assertTrue(is_excluded_publication("WED-174-YI Machine learning prediction of fibrosis"))
        self.assertTrue(is_excluded_publication("A Nature briefing", "10.1038/d41586-026-00001-1"))

    def test_keeps_original_article(self) -> None:
        self.assertFalse(is_excluded_publication("Adipocyte metabolism controls thermogenesis", "10.1038/s41586-026-12345-6"))


if __name__ == "__main__":
    unittest.main()
