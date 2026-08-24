from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

import requests

from paper_agent.collectors.crossref import CrossrefCollector


DEFAULT_PAPERS = Path("public/data/papers.json")
DEFAULT_SOURCE_INDEX = Path("data/paper_analysis/source_index.json")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill missing public-paper abstracts from Crossref DOI records."
    )
    parser.add_argument("--papers-file", type=Path, default=DEFAULT_PAPERS)
    parser.add_argument("--source-index", type=Path, default=DEFAULT_SOURCE_INDEX)
    parser.add_argument("--limit", type=int, default=0, help="Maximum due papers; 0 means all.")
    parser.add_argument("--retry-days", type=int, default=30)
    parser.add_argument("--pause-seconds", type=float, default=0.25)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    payload = load_json(args.papers_file, {})
    papers = payload.get("papers")
    if not isinstance(papers, list):
        raise ValueError(f"{args.papers_file} does not contain a papers list")
    index = load_json(
        args.source_index,
        {"schemaVersion": 1, "generatedAt": None, "papers": {}},
    )
    collector = CrossrefCollector(
        mailto=os.environ.get("LMI_CROSSREF_MAILTO") or None,
        pause_seconds=max(args.pause_seconds, 0),
    )

    def checkpoint() -> None:
        index["generatedAt"] = utc_now()
        write_json(args.source_index, index)

    stats = backfill_crossref_abstracts(
        papers=papers,
        index=index,
        collector=collector,
        retry_days=args.retry_days,
        limit=args.limit,
        refresh=args.refresh,
        pause_seconds=max(args.pause_seconds, 0),
        checkpoint=checkpoint,
    )
    checkpoint()
    print(f"Crossref due: {stats['due']}")
    print(f"Abstracts recovered: {stats['recovered']}")
    print(f"Abstracts unavailable: {stats['unavailable']}")
    print(f"Request errors: {stats['errors']}")


def backfill_crossref_abstracts(
    papers: list[dict],
    index: dict,
    collector: CrossrefCollector,
    retry_days: int = 30,
    limit: int = 0,
    refresh: bool = False,
    pause_seconds: float = 0,
    checkpoint: Callable[[], None] | None = None,
) -> dict[str, int]:
    records = index.setdefault("papers", {})
    retry_before = datetime.now(timezone.utc) - timedelta(days=max(retry_days, 0))
    due = []
    for paper in papers:
        paper_id = str(paper.get("id") or "").strip()
        doi = str(paper.get("doi") or "").strip()
        existing = records.get(paper_id, {})
        if not paper_id or not doi or paper.get("abstract") or existing.get("abstract"):
            continue
        checked_at = parse_datetime(existing.get("crossrefCheckedAt"))
        recently_unavailable = (
            existing.get("crossrefStatus") == "unavailable"
            and checked_at is not None
            and checked_at > retry_before
        )
        if refresh or not recently_unavailable:
            due.append(paper)
    if limit > 0:
        due = due[:limit]

    stats = {"due": len(due), "recovered": 0, "unavailable": 0, "errors": 0}
    for position, paper in enumerate(due, start=1):
        paper_id = str(paper["id"])
        doi = str(paper["doi"])
        existing = records.setdefault(paper_id, {"doi": doi})
        checked_at = utc_now()
        try:
            result = collector.fetch_by_doi(doi, fallback_journal=str(paper.get("journal") or ""))
        except requests.RequestException as exc:
            existing["crossrefStatus"] = "error"
            existing["crossrefLastError"] = str(exc)[:500]
            stats["errors"] += 1
        else:
            abstract = (result.abstract if result else "").strip()
            existing["crossrefCheckedAt"] = checked_at
            existing["crossrefLastError"] = ""
            if abstract:
                source_url = result.url or f"https://doi.org/{doi}"
                existing.update(
                    {
                        "status": "source_ready",
                        "evidenceLevel": existing.get("evidenceLevel") or "abstract",
                        "sourceUrl": existing.get("sourceUrl") or source_url,
                        "abstract": abstract,
                        "abstractStatus": "available",
                        "abstractCharacters": len(abstract),
                        "abstractProvider": "Crossref",
                        "abstractSourceUrl": source_url,
                        "crossrefStatus": "available",
                    }
                )
                stats["recovered"] += 1
            else:
                existing.setdefault("abstract", "")
                existing.setdefault("abstractStatus", "unavailable")
                existing["crossrefStatus"] = "unavailable"
                stats["unavailable"] += 1
        if checkpoint and (position % 25 == 0 or position == len(due)):
            checkpoint()
        if pause_seconds > 0 and position < len(due):
            time.sleep(pause_seconds)
    return stats


def load_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
