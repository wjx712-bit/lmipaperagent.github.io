from __future__ import annotations

import copy
import csv
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from paper_agent.backfill_unclassified_topics import UNCLASSIFIED, plan_backfill, replace_files
from paper_agent.export_site_json import build_site_payload

PROFILE = {"keyword_groups": {"adipose": {"terms": ["adipocyte"], "weight": 5}}}
RUBRIC = {"themes": {"adipose": {"display": "Adipose tissue / adipocyte biology", "keyword_groups": ["adipose"]}}}


def paper(identifier, topics, abstract="We studied adipocyte function."):
    return {"id": identifier, "doi": identifier, "title": identifier, "journal": "Nature",
            "topics": topics, "abstract": abstract, "abstractKo": "Original translation",
            "aiScore": 45, "relevanceRaw": 5, "priority": "Archive only", "aiReason": "Original reason"}


class TopicBackfillTests(unittest.TestCase):
    def fixture(self):
        papers = [paper("10.1/existing", ["Original topic"]), paper("10.1/empty", []),
                  paper("10.1/unknown", [], "No recognizable study terms.")]
        rows = [{"doi": p["doi"], "title": p["title"], "journal": p["journal"],
                 "themes": "; ".join(p["topics"]), "score": "5", "abstract": "",
                 "published_date": "2026-09-01", "matched_terms": ""} for p in papers]
        rows.append({"doi": "10.1/not-public", "themes": "", "score": "3"})
        return {"generatedAt": "original", "papers": papers}, rows

    def test_only_empty_public_topics_and_matching_catalog_themes_change(self):
        payload, rows = self.fixture()
        originals = copy.deepcopy((payload, rows))
        result, updated_rows, report = plan_backfill(payload, rows, PROFILE, RUBRIC)
        self.assertEqual(originals, (payload, rows))
        self.assertEqual(payload["papers"][0], result["papers"][0])
        self.assertEqual(rows[0], updated_rows[0])
        self.assertEqual(rows[3], updated_rows[3])
        self.assertEqual([UNCLASSIFIED], result["papers"][2]["topics"])
        self.assertEqual(RUBRIC["themes"]["adipose"]["display"], updated_rows[1]["themes"])
        for before, after in zip(payload["papers"], result["papers"]):
            self.assertEqual({k: v for k, v in before.items() if k != "topics"},
                             {k: v for k, v in after.items() if k != "topics"})
        for before, after in zip(rows, updated_rows):
            self.assertEqual({k: v for k, v in before.items() if k != "themes"},
                             {k: v for k, v in after.items() if k != "themes"})
        self.assertEqual(2, report["summary"]["updated"])
        self.assertEqual(1, report["summary"]["newlyClassified"])
        self.assertEqual(1, report["summary"]["newlyUnclassifiedGroup"])

    def test_repeat_is_noop_even_for_explicit_unclassified(self):
        payload, rows = self.fixture()
        first, updated, _ = plan_backfill(payload, rows, PROFILE, RUBRIC)
        again, rows_again, report = plan_backfill(first, updated, PROFILE, RUBRIC)
        self.assertEqual(first, again)
        self.assertEqual(updated, rows_again)
        self.assertEqual(0, report["summary"]["updated"])

    def test_export_keeps_persisted_topics_after_abstract_refresh(self):
        payload, rows = self.fixture()
        result, updated, _ = plan_backfill(payload, rows, PROFILE, RUBRIC)
        with tempfile.TemporaryDirectory() as directory:
            catalog = Path(directory) / "catalog.csv"
            with catalog.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=rows[0].keys())
                writer.writeheader()
                writer.writerows(updated[:3])
            exported = build_site_payload(catalog, as_of=date(2026, 9, 10), include_missing_abstracts=True)
        self.assertEqual({p["id"]: p["topics"] for p in result["papers"]},
                         {p["id"]: p["topics"] for p in exported["papers"]})

    def test_refuses_duplicate_or_missing_identity_and_catalog_conflict(self):
        payload, rows = self.fixture()
        with self.assertRaises(ValueError):
            plan_backfill(payload, rows + [rows[1]], PROFILE, RUBRIC)
        with self.assertRaises(ValueError):
            plan_backfill(payload, rows[:1], PROFILE, RUBRIC)
        conflict = copy.deepcopy(rows)
        conflict[1]["themes"] = "Other assignment"
        with self.assertRaises(ValueError):
            plan_backfill(payload, conflict, PROFILE, RUBRIC)
        payload["papers"][1]["id"] = payload["papers"][0]["id"]
        with self.assertRaises(ValueError):
            plan_backfill(payload, rows, PROFILE, RUBRIC)

    def test_files_unchanged_when_input_or_existing_report_conflicts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input"
            path.write_bytes(b"changed")
            with self.assertRaises(ValueError):
                replace_files({path: b"updated"}, {path: b"reviewed"})
            self.assertEqual(b"changed", path.read_bytes())
            with self.assertRaises(ValueError):
                replace_files({path: b"updated"}, {path: None})
            self.assertEqual([path], list(Path(directory).iterdir()))

    def test_rolls_back_first_file_if_second_replacement_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "first", Path(directory) / "second"
            first.write_bytes(b"old1")
            second.write_bytes(b"old2")
            original_replace = os.replace
            def replace(source, destination):
                if destination == second:
                    raise OSError("Simulated write failure")
                original_replace(source, destination)
            with patch("paper_agent.backfill_unclassified_topics.os.replace", side_effect=replace):
                with self.assertRaises(OSError):
                    replace_files({first: b"new1", second: b"new2"}, {first: b"old1", second: b"old2"})
            self.assertEqual(b"old1", first.read_bytes())
            self.assertEqual(b"old2", second.read_bytes())
            self.assertEqual(2, len(list(Path(directory).iterdir())))


if __name__ == "__main__":
    unittest.main()
