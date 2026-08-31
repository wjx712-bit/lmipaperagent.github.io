from __future__ import annotations

import unittest
from datetime import date

from paper_agent.collectors.crossref import CrossrefCollector
from paper_agent.models import Journal


class _EmptyResponse:
    def json(self) -> dict:
        return {"message": {"items": [], "next-cursor": ""}}


class CrossrefCursorTests(unittest.TestCase):
    def test_cursor_pagination_omits_incompatible_published_sort(self) -> None:
        collector = CrossrefCollector(pause_seconds=0)
        captured_params: list[dict] = []

        def request(params: dict) -> _EmptyResponse:
            captured_params.append(dict(params))
            return _EmptyResponse()

        collector._request_with_retries = request  # type: ignore[method-assign]
        journal = Journal(
            name="Nature",
            tier="I",
            priority_weight=1,
            query_titles=["Nature"],
            issns=["0028-0836"],
        )

        collector._fetch_journal_query(
            journal=journal,
            query_title="0028-0836",
            query_kind="issn",
            from_date=date(2026, 8, 17),
            until_date=date(2026, 8, 31),
            rows=1000,
            max_pages=5,
            pagination="cursor",
            progress_callback=None,
        )

        self.assertEqual("*", captured_params[0]["cursor"])
        self.assertNotIn("sort", captured_params[0])
        self.assertNotIn("order", captured_params[0])


if __name__ == "__main__":
    unittest.main()
