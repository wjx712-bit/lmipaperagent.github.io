from __future__ import annotations

import html
import re
import time
from calendar import monthrange
from datetime import date
from typing import Callable, Iterable
from urllib.parse import quote

import requests

from paper_agent.abstract_text import strip_leading_abstract_label
from paper_agent.models import Journal, Paper


_TAG_RE = re.compile(r"<[^>]+>")


class CrossrefCollector:
    """Collect article metadata from the public Crossref API."""

    def __init__(self, mailto: str | None = None, pause_seconds: float = 0.8) -> None:
        self.mailto = mailto
        self.pause_seconds = pause_seconds
        self.session = requests.Session()

    def fetch_recent(
        self,
        journals: Iterable[Journal],
        from_date: date | None,
        until_date: date | None,
        rows_per_query: int = 50,
        max_pages: int = 1,
        pagination: str = "cursor",
        progress_callback: Callable[[str], None] | None = None,
    ) -> list[Paper]:
        papers: dict[str, Paper] = {}
        for journal in journals:
            query_keys = journal.issns or journal.query_titles
            for query_key in query_keys:
                for paper in self._fetch_journal_query(
                    journal=journal,
                    query_title=query_key,
                    query_kind="issn" if journal.issns else "title",
                    from_date=from_date,
                    until_date=until_date,
                    rows=rows_per_query,
                    max_pages=max_pages,
                    pagination=pagination,
                    progress_callback=progress_callback,
                ):
                    papers[paper.stable_id] = paper
                time.sleep(self.pause_seconds)
        return list(papers.values())

    def fetch_by_doi(self, doi: str, fallback_journal: str = "") -> Paper | None:
        normalized_doi = _normalize_doi(doi)
        if not normalized_doi:
            return None
        params = {"mailto": self.mailto} if self.mailto else None
        try:
            response = self._request_url_with_retries(
                f"https://api.crossref.org/works/{quote(normalized_doi, safe='')}",
                params=params,
            )
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                return None
            raise
        item = response.json().get("message", {})
        if not isinstance(item, dict) or not item:
            return None
        return self._parse_item(item, fallback_journal=fallback_journal)

    def fetch_all(
        self,
        journals: Iterable[Journal],
        rows_per_query: int = 1000,
        max_pages: int = 10,
        start_year: int | None = None,
        progress_callback: Callable[[str], None] | None = None,
    ) -> list[Paper]:
        return self.fetch_all_by_year(
            journals=journals,
            rows_per_query=rows_per_query,
            max_pages_per_year=max_pages,
            start_year=start_year,
            progress_callback=progress_callback,
        )

    def fetch_all_by_year(
        self,
        journals: Iterable[Journal],
        rows_per_query: int = 1000,
        max_pages_per_year: int = 10,
        start_year: int | None = None,
        until_year: int | None = None,
        progress_callback: Callable[[str], None] | None = None,
    ) -> list[Paper]:
        current_year = until_year or date.today().year
        papers: dict[str, Paper] = {}
        for journal in journals:
            journal_start_year = max(
                year
                for year in [start_year or 0, journal.start_year or 0, 1850]
                if year
            )
            query_keys = journal.issns or journal.query_titles
            for query_key in query_keys:
                for year in range(current_year, journal_start_year - 1, -1):
                    for paper in self._fetch_window_adaptive(
                        journal=journal,
                        query_title=query_key,
                        query_kind="issn" if journal.issns else "title",
                        year=year,
                        rows=rows_per_query,
                        max_pages=max_pages_per_year,
                        progress_callback=progress_callback,
                    ):
                        papers[paper.stable_id] = paper
                    time.sleep(self.pause_seconds)
                time.sleep(self.pause_seconds)
        return list(papers.values())

    def _fetch_window_adaptive(
        self,
        journal: Journal,
        query_title: str,
        query_kind: str,
        year: int,
        rows: int,
        max_pages: int,
        progress_callback: Callable[[str], None] | None,
    ) -> list[Paper]:
        papers = self._fetch_journal_query(
            journal=journal,
            query_title=query_title,
            query_kind=query_kind,
            from_date=date(year, 1, 1),
            until_date=date(year, 12, 31),
            rows=rows,
            max_pages=max_pages,
            pagination="offset",
            progress_callback=progress_callback,
        )
        if max_pages <= 0 or len(papers) < rows * max_pages:
            return papers

        if progress_callback:
            progress_callback(
                f"{journal.name} {year} / {query_kind}:{query_title}: "
                "year window reached page cap; splitting by month"
            )

        monthly: dict[str, Paper] = {}
        for month in range(1, 13):
            month_start = date(year, month, 1)
            month_end = date(year, month, monthrange(year, month)[1])
            for paper in self._fetch_journal_query(
                journal=journal,
                query_title=query_title,
                query_kind=query_kind,
                from_date=month_start,
                until_date=month_end,
                rows=rows,
                max_pages=max_pages,
                pagination="offset",
                progress_callback=progress_callback,
            ):
                monthly[paper.stable_id] = paper
            time.sleep(self.pause_seconds)
        return list(monthly.values())

    def _fetch_journal_query(
        self,
        journal: Journal,
        query_title: str,
        query_kind: str,
        from_date: date | None,
        until_date: date | None,
        rows: int,
        max_pages: int,
        pagination: str,
        progress_callback: Callable[[str], None] | None,
    ) -> list[Paper]:
        rows = min(max(rows, 1), 1000)
        filters = ["type:journal-article"]
        if from_date:
            filters.append(f"from-pub-date:{from_date.isoformat()}")
        if until_date:
            filters.append(f"until-pub-date:{until_date.isoformat()}")
        params = {
            "filter": ",".join(filters),
            "select": "title,container-title,DOI,URL,published-print,published-online,author,abstract,volume,issue",
            "sort": "published",
            "order": "desc",
            "rows": rows,
        }
        if query_kind == "issn":
            filters.append(f"issn:{query_title}")
            params["filter"] = ",".join(filters)
        else:
            params["query.container-title"] = query_title
        if self.mailto:
            params["mailto"] = self.mailto

        page_limit = None if max_pages <= 0 else max_pages
        if pagination == "cursor" and (page_limit is None or page_limit > 1):
            # Crossref rejects publication-date sorting when cursor pagination is used.
            # The date filters still constrain the result set, and callers sort parsed
            # papers themselves when presentation order matters.
            params.pop("sort", None)
            params.pop("order", None)
            params["cursor"] = "*"
        elif pagination == "offset":
            params["offset"] = 0

        papers: list[Paper] = []
        seen_cursors: set[str] = set()
        page_number = 0
        while page_limit is None or page_number < max(page_limit, 1):
            response = self._request_with_retries(params)
            message = response.json().get("message", {})
            items = message.get("items", [])
            parsed = [self._parse_item(item, fallback_journal=journal.name) for item in items]
            matching = []
            for paper in parsed:
                if _is_matching_journal(paper.journal, journal):
                    paper.journal = journal.name
                    matching.append(paper)
            papers.extend(matching)
            page_number += 1

            if progress_callback:
                date_label = ""
                if from_date and until_date and from_date.year == until_date.year:
                    if from_date.month == 1 and until_date.month == 12:
                        date_label = f" {from_date.year}"
                    elif from_date.month == until_date.month:
                        date_label = f" {from_date:%Y-%m}"
                    else:
                        date_label = f" {from_date.isoformat()}~{until_date.isoformat()}"
                progress_callback(
                    f"{journal.name}{date_label} / {query_kind}:{query_title} page {page_number}: "
                    f"{len(matching)} matched, {len(items)} fetched"
                )

            if pagination == "offset":
                next_offset = page_number * rows
                if page_limit == 1 or not items or len(items) < rows or next_offset >= 10000:
                    break
                params["offset"] = next_offset
            else:
                next_cursor = str(message.get("next-cursor") or "")
                if page_limit == 1 or not items or len(items) < rows or not next_cursor:
                    break
                if next_cursor in seen_cursors:
                    break
                seen_cursors.add(next_cursor)
                params["cursor"] = next_cursor
            if page_limit is None or page_number < page_limit:
                time.sleep(self.pause_seconds)
        return papers

    def _request_with_retries(self, params: dict) -> requests.Response:
        return self._request_url_with_retries("https://api.crossref.org/works", params=params)

    def _request_url_with_retries(
        self,
        url: str,
        params: dict | None = None,
    ) -> requests.Response:
        last_error: requests.RequestException | None = None
        for attempt in range(3):
            try:
                response = self.session.get(
                    url,
                    params=params,
                    timeout=45,
                    headers={"User-Agent": "lmi-paper-agent/0.1"},
                )
                response.raise_for_status()
                return response
            except requests.HTTPError as exc:
                if (
                    exc.response is not None
                    and 400 <= exc.response.status_code < 500
                    and exc.response.status_code not in {408, 429}
                ):
                    raise
                last_error = exc
                time.sleep(max(self.pause_seconds, 0.5) * (attempt + 1))
            except requests.RequestException as exc:
                last_error = exc
                time.sleep(max(self.pause_seconds, 0.5) * (attempt + 1))
        assert last_error is not None
        raise last_error

    def _parse_item(self, item: dict, fallback_journal: str) -> Paper:
        title = _first(item.get("title")) or "(Untitled)"
        journal = _first(item.get("container-title")) or fallback_journal
        doi = str(item.get("DOI") or "").strip()
        url = str(item.get("URL") or "").strip()
        abstract = _clean_abstract(str(item.get("abstract") or ""))
        published_date = _extract_date(item)
        authors = [_format_author(author) for author in item.get("author", [])]

        return Paper(
            title=title,
            journal=journal,
            doi=doi,
            url=url,
            published_date=published_date,
            authors=[author for author in authors if author],
            abstract=abstract,
            volume=str(item.get("volume") or "").strip(),
            issue=str(item.get("issue") or "").strip(),
        )


def _first(values: list[str] | None) -> str:
    if not values:
        return ""
    return str(values[0]).strip()


def _extract_date(item: dict) -> date | None:
    for key in ("published-online", "published-print"):
        date_parts = item.get(key, {}).get("date-parts", [])
        if not date_parts or not date_parts[0]:
            continue
        parts = list(date_parts[0])
        year = int(parts[0])
        month = int(parts[1]) if len(parts) > 1 else 1
        day = int(parts[2]) if len(parts) > 2 else 1
        return date(year, month, day)
    return None


def _format_author(author: dict) -> str:
    given = str(author.get("given") or "").strip()
    family = str(author.get("family") or "").strip()
    return " ".join(part for part in [given, family] if part)


def _clean_abstract(raw: str) -> str:
    if not raw:
        return ""
    without_tags = _TAG_RE.sub(" ", raw)
    return strip_leading_abstract_label(" ".join(html.unescape(without_tags).split()))


def _normalize_doi(raw: str) -> str:
    value = str(raw or "").strip().lower()
    value = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value)
    return value.removeprefix("doi:").strip()


def _is_matching_journal(container_title: str, journal: Journal) -> bool:
    accepted_titles = [journal.name, *journal.query_titles]
    normalized_container = _normalize_journal_title(container_title)
    return normalized_container in {_normalize_journal_title(title) for title in accepted_titles}


def _normalize_journal_title(title: str) -> str:
    normalized = html.unescape(title).lower()
    normalized = normalized.replace("&", "and")
    normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
    return " ".join(normalized.split())
