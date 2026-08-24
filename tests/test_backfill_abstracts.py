from __future__ import annotations

import unittest
from datetime import date

from paper_agent.backfill_abstracts import backfill_crossref_abstracts
from paper_agent.models import Paper


class FakeCollector:
    def fetch_by_doi(self, doi: str, fallback_journal: str = "") -> Paper | None:
        abstract = "Recovered abstract." if doi.endswith("/found") else ""
        return Paper(
            title="Paper",
            journal=fallback_journal,
            doi=doi,
            url=f"https://doi.org/{doi}",
            published_date=date(2026, 8, 1),
            abstract=abstract,
        )


class BackfillAbstractsTests(unittest.TestCase):
    def test_recovers_abstract_and_records_unavailable_result(self) -> None:
        papers = [
            {"id": "10.1/found", "doi": "10.1/found", "journal": "Nature", "abstract": ""},
            {"id": "10.1/missing", "doi": "10.1/missing", "journal": "Nature", "abstract": ""},
        ]
        index = {
            "papers": {
                "10.1/found": {
                    "provider": "Europe PMC",
                    "status": "not_found",
                    "abstract": "",
                }
            }
        }

        stats = backfill_crossref_abstracts(papers, index, FakeCollector())

        self.assertEqual(2, stats["due"])
        self.assertEqual(1, stats["recovered"])
        self.assertEqual(1, stats["unavailable"])
        recovered = index["papers"]["10.1/found"]
        self.assertEqual("Recovered abstract.", recovered["abstract"])
        self.assertEqual("Crossref", recovered["abstractProvider"])
        self.assertEqual("Europe PMC", recovered["provider"])
        self.assertEqual("https://doi.org/10.1/found", recovered["abstractSourceUrl"])

        second_stats = backfill_crossref_abstracts(papers, index, FakeCollector())
        self.assertEqual(0, second_stats["due"])


if __name__ == "__main__":
    unittest.main()
