from __future__ import annotations

import unittest

from paper_agent.abstract_text import strip_leading_abstract_label


class AbstractTextTests(unittest.TestCase):
    def test_removes_only_a_leading_abstract_label(self) -> None:
        self.assertEqual("Adipocytes regulate metabolism.", strip_leading_abstract_label("Abstract Adipocytes regulate metabolism."))
        self.assertEqual("Adipocytes regulate metabolism.", strip_leading_abstract_label("ABSTRACT: Adipocytes regulate metabolism."))

    def test_preserves_abstract_inside_normal_text(self) -> None:
        self.assertEqual("An abstract concept.", strip_leading_abstract_label("An abstract concept."))
        self.assertEqual("Abstracting the signal.", strip_leading_abstract_label("Abstracting the signal."))


if __name__ == "__main__":
    unittest.main()
