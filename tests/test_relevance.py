from datetime import date
from pathlib import Path
import unittest

from paper_agent.config import load_lab_profile, load_optional_yaml
from paper_agent.models import Paper
from paper_agent.relevance import score_paper


class RelevanceTests(unittest.TestCase):
    def test_lmi_topic_scores_relevant_paper(self) -> None:
        lab_profile = {
            "keyword_groups": {
                "adipose_axis": {
                    "weight": 5,
                    "terms": ["adipocyte", "thermogenesis"],
                },
                "inflammation_immunity": {
                    "weight": 4,
                    "terms": ["macrophage"],
                },
            },
            "scoring": {
                "title_multiplier": 2.0,
                "abstract_multiplier": 1.0,
                "journal_priority_multiplier": 1.0,
            },
        }
        paper = Paper(
            title="Adipocyte thermogenesis controls metabolic inflammation",
            journal="Nature Metabolism",
            doi="10.0000/example",
            url="https://doi.org/10.0000/example",
            published_date=date(2026, 6, 25),
            abstract="Macrophage remodeling in adipose tissue is linked to obesity.",
        )

        scored = score_paper(paper, lab_profile, journal_priority=3)

        self.assertGreater(scored.score, 10)
        self.assertIn("adipose_axis", scored.matched_groups)
        self.assertIn("inflammation_immunity", scored.matched_groups)

    def test_adipose_theme_rejects_ambiguous_bat_and_general_mitochondria(self) -> None:
        config_dir = Path(__file__).parents[1] / "config"
        profile = load_lab_profile(config_dir, "lab_profile.yml")
        rubric = load_optional_yaml(config_dir, "relevance_rubric.yml")
        papers = [
            Paper(
                title="Migratory bat navigation under radiofrequency exposure",
                journal="Science",
                doi="10.0000/bat",
                url="",
                published_date=date(2026, 6, 25),
                abstract="We studied bats during migration.",
            ),
            Paper(
                title="Mitochondrial dysfunction in skeletal muscle",
                journal="Nature Metabolism",
                doi="10.0000/muscle",
                url="",
                published_date=date(2026, 6, 25),
                abstract="Thermogenesis and mitochondrial dysfunction were measured in muscle.",
            ),
        ]

        for paper in papers:
            scored = score_paper(paper, profile, journal_priority=3, rubric=rubric)
            self.assertNotIn("Adipose tissue / adipocyte biology", scored.matched_themes)

    def test_adipose_theme_accepts_progenitors_and_beige_fat(self) -> None:
        config_dir = Path(__file__).parents[1] / "config"
        profile = load_lab_profile(config_dir, "lab_profile.yml")
        rubric = load_optional_yaml(config_dir, "relevance_rubric.yml")
        paper = Paper(
            title="Adipose progenitors control beige fat remodeling",
            journal="Nature Metabolism",
            doi="10.0000/adipose",
            url="",
            published_date=date(2026, 6, 25),
            abstract="Adipogenesis in subcutaneous adipose tissue was mapped at single-cell resolution.",
        )

        scored = score_paper(paper, profile, journal_priority=3, rubric=rubric)

        self.assertIn("adipose_axis", scored.matched_groups)
        self.assertIn("Adipose tissue / adipocyte biology", scored.matched_themes)


if __name__ == "__main__":
    unittest.main()
