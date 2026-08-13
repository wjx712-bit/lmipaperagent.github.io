from __future__ import annotations

import csv
import tempfile
import unittest
from datetime import date
from pathlib import Path

from paper_agent.merge_table_csv import merge_table_files
from paper_agent.models import Paper
from paper_agent.run_weekly_update import initialize_catalog, load_table_keys, paper_key


FIELDS = ["range_start", "range_end", "journal", "published_date", "title", "score", "doi"]


class WeeklyUpdateTests(unittest.TestCase):
    def write_rows(self, path: Path, rows: list[dict[str, str]]) -> None:
        with path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(rows)

    def test_catalog_bootstrap_preserves_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            baseline = root / "baseline.csv"
            catalog = root / "nested" / "catalog.csv"
            self.write_rows(baseline, [{"doi": "10.1/base", "title": "Base"}])

            initialize_catalog(baseline, catalog)

            self.assertEqual(baseline.read_bytes(), catalog.read_bytes())
            self.assertEqual({"doi:10.1/base"}, load_table_keys(catalog))

    def test_existing_catalog_does_not_need_a_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = Path(temp_dir) / "catalog.csv"
            self.write_rows(catalog, [{"doi": "10.1/live", "title": "Live"}])

            self.assertEqual({"doi:10.1/live"}, load_table_keys(catalog))

    def test_merge_keeps_higher_scored_duplicate_and_adds_new_paper(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            base = root / "base.csv"
            supplement = root / "supplement.csv"
            self.write_rows(base, [{"doi": "10.1/same", "title": "Same", "score": "5"}])
            self.write_rows(
                supplement,
                [
                    {"doi": "10.1/same", "title": "Same", "score": "9"},
                    {"doi": "10.1/new", "title": "New", "score": "7"},
                ],
            )

            result = merge_table_files(base, supplement, base)
            with base.open("r", encoding="utf-8-sig", newline="") as handle:
                rows = list(csv.DictReader(handle))

            self.assertEqual(2, result["merged_rows"])
            self.assertEqual("9", next(row for row in rows if row["doi"] == "10.1/same")["score"])

    def test_paper_key_matches_csv_doi_key(self) -> None:
        paper = Paper(
            title="A paper",
            journal="Nature",
            doi="10.1000/ABC",
            url="",
            published_date=date(2026, 7, 12),
        )
        self.assertEqual("doi:10.1000/abc", paper_key(paper))


if __name__ == "__main__":
    unittest.main()
