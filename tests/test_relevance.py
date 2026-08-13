from datetime import date

from paper_agent.models import Paper
from paper_agent.relevance import score_paper


def test_lmi_topic_scores_relevant_paper():
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

    assert scored.score > 10
    assert "adipose_axis" in scored.matched_groups
    assert "inflammation_immunity" in scored.matched_groups
