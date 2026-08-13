from __future__ import annotations

import csv
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from paper_agent.export_site_json import build_site_payload


class SiteJsonExportTests(unittest.TestCase):
    def test_exports_recent_real_papers_and_expert_recommendations(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = root / "catalog.csv"
            state = root / "state.json"
            recommendations = root / "recommendations.csv"
            fields = [
                "range_end", "journal", "published_date", "title", "authors", "score",
                "priority", "themes", "matched_terms", "doi", "url", "volume", "issue",
            ]
            with catalog.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fields)
                writer.writeheader()
                writer.writerows([
                    {
                        "range_end": "2026-08-09", "journal": "Nature Metabolism",
                        "published_date": "2026-08-01", "title": "<i>Adipose</i> study",
                        "authors": "A. Kim, B. Lee", "score": "18", "priority": "Must read",
                        "themes": "Adipose biology; Aging", "matched_terms": "axis: adipocyte, Treg",
                        "doi": "10.1/TEST", "url": "", "volume": "8", "issue": "2",
                    },
                    {
                        "range_end": "2024-01-01", "journal": "Nature",
                        "published_date": "2024-01-01", "title": "Old paper", "doi": "10.1/old",
                    },
                    {
                        "range_end": "2026-08-09", "journal": "Nature Aging",
                        "published_date": "2026-08-02", "title": "Author Correction: Adipose study",
                        "doi": "10.1/correction",
                    },
                ])
            state.write_text(json.dumps({"status": "success", "completed_at": "2026-08-09T00:00:00Z", "new_count": 3}), encoding="utf-8")
            with recommendations.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["doi", "name", "role", "note"])
                writer.writeheader()
                writer.writerow({"doi": "10.1/test", "name": "Kim", "role": "Professor", "note": "Read"})

            payload = build_site_payload(catalog, state, recommendations, since_days=365, as_of=date(2026, 8, 13))

            self.assertEqual(1, len(payload["papers"]))
            paper = payload["papers"][0]
            self.assertEqual("Adipose study", paper["title"])
            self.assertEqual("Nat Metab", paper["journalShort"])
            self.assertEqual(79, paper["aiScore"])
            self.assertEqual("Kim", paper["recommendedBy"]["name"])
            self.assertEqual("success", payload["source"]["lastRunStatus"])


if __name__ == "__main__":
    unittest.main()
