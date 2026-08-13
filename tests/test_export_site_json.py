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
                "abstract",
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
                        "abstract": "Adipocyte inflammation shapes tissue metabolism.",
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
            self.assertEqual("Adipocyte inflammation shapes tissue metabolism.", paper["abstract"])

    def test_excludes_papers_without_an_abstract(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = Path(temp_dir) / "catalog.csv"
            with catalog.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["range_end", "journal", "published_date", "title", "doi", "abstract"],
                )
                writer.writeheader()
                writer.writerows([
                    {
                        "range_end": "2026-08-09",
                        "journal": "Nature",
                        "published_date": "2026-08-01",
                        "title": "With abstract",
                        "doi": "10.1/with",
                        "abstract": "A real abstract.",
                    },
                    {
                        "range_end": "2026-08-09",
                        "journal": "Nature",
                        "published_date": "2026-08-01",
                        "title": "Without abstract",
                        "doi": "10.1/without",
                        "abstract": "",
                    },
                ])

            payload = build_site_payload(catalog, as_of=date(2026, 8, 13))

            self.assertEqual(["10.1/with"], [paper["id"] for paper in payload["papers"]])

    def test_uses_abstract_from_source_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = root / "catalog.csv"
            source_index = root / "source-index.json"
            with catalog.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(
                    handle,
                    fieldnames=["range_end", "journal", "published_date", "title", "doi"],
                )
                writer.writeheader()
                writer.writerow({
                    "range_end": "2026-08-09",
                    "journal": "Nature",
                    "published_date": "2026-08-01",
                    "title": "Indexed abstract",
                    "doi": "10.1/indexed",
                })
            source_index.write_text(
                json.dumps({
                    "papers": {
                        "10.1/indexed": {
                            "abstract": "Abstract from Europe PMC.",
                            "sourceUrl": "https://europepmc.org/article/MED/1",
                        }
                    }
                }),
                encoding="utf-8",
            )

            payload = build_site_payload(
                catalog,
                source_index_path=source_index,
                as_of=date(2026, 8, 13),
            )

            self.assertEqual("Abstract from Europe PMC.", payload["papers"][0]["abstract"])
            self.assertEqual(
                "https://europepmc.org/article/MED/1",
                payload["papers"][0]["abstractSourceUrl"],
            )


if __name__ == "__main__":
    unittest.main()
