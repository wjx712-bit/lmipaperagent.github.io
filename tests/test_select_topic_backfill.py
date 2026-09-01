from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path

from paper_agent.select_topic_backfill import prune_catalog_to_topic_selection, select_topic_rows


class TopicBackfillTests(unittest.TestCase):
    def test_selects_latest_target_rows_for_exact_theme(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.csv"
            output = root / "output.csv"
            fieldnames = ["published_date", "title", "journal", "doi", "score", "themes"]
            rows = [
                {"published_date": "2024-01-01", "title": "Old adipose", "journal": "Cell", "doi": "10.1/old", "score": "9", "themes": "Adipose tissue / adipocyte biology"},
                {"published_date": "2026-01-01", "title": "New adipose", "journal": "Cell", "doi": "10.1/new", "score": "8", "themes": "Adipose tissue / adipocyte biology; Aging / senescence"},
                {"published_date": "2026-02-01", "title": "Immune only", "journal": "Cell", "doi": "10.1/immune", "score": "20", "themes": "Inflammation / immune regulation"},
            ]
            with source.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)

            count = select_topic_rows(
                source,
                output,
                "Adipose tissue / adipocyte biology",
                target_count=1,
            )

            with output.open("r", encoding="utf-8-sig", newline="") as handle:
                selected = list(csv.DictReader(handle))
            self.assertEqual(1, count)
            self.assertEqual(["New adipose"], [row["title"] for row in selected])

    def test_prunes_only_unselected_rows_from_target_theme(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            catalog = root / "catalog.csv"
            selection = root / "selection.csv"
            output = root / "output.csv"
            fieldnames = ["published_date", "title", "journal", "doi", "score", "themes"]
            rows = [
                {"published_date": "2026-01-01", "title": "Keep adipose", "journal": "Cell", "doi": "10.1/keep", "score": "8", "themes": "Adipose tissue / adipocyte biology"},
                {"published_date": "2024-01-01", "title": "Drop adipose", "journal": "Cell", "doi": "10.1/drop", "score": "8", "themes": "Adipose tissue / adipocyte biology"},
                {"published_date": "2024-01-01", "title": "Keep immune", "journal": "Cell", "doi": "10.1/immune", "score": "8", "themes": "Inflammation / immune regulation"},
            ]
            for path, selected_rows in ((catalog, rows), (selection, rows[:1])):
                with path.open("w", encoding="utf-8-sig", newline="") as handle:
                    writer = csv.DictWriter(handle, fieldnames=fieldnames)
                    writer.writeheader()
                    writer.writerows(selected_rows)

            count = prune_catalog_to_topic_selection(
                catalog,
                selection,
                output,
                "Adipose tissue / adipocyte biology",
            )

            with output.open("r", encoding="utf-8-sig", newline="") as handle:
                kept = list(csv.DictReader(handle))
            self.assertEqual(2, count)
            self.assertEqual({"Keep adipose", "Keep immune"}, {row["title"] for row in kept})


if __name__ == "__main__":
    unittest.main()
