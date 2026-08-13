from __future__ import annotations

import argparse
import csv
import html
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from paper_agent.collectors.crossref import CrossrefCollector
from paper_agent.config import load_journals, load_lab_profile, load_optional_yaml
from paper_agent.feedback import (
    apply_feedback_adjustments,
    learn_group_adjustments,
    load_feedback_records,
)
from paper_agent.models import Journal, ScoredPaper
from paper_agent.relevance import score_papers
from paper_agent.rubric import priority_display


def main() -> None:
    parser = argparse.ArgumentParser(description="Export journal-organized paper candidates to CSV.")
    parser.add_argument("--config-dir", default="config")
    parser.add_argument("--lab-profile-file", default="lab_profile.yml")
    parser.add_argument("--journals-file", default="journals_tier_i.yml")
    parser.add_argument("--rubric-file", default="relevance_rubric.yml")
    parser.add_argument("--feedback-file", default="feedback_labels.csv")
    parser.add_argument("--days", type=int, default=61)
    parser.add_argument("--all-time", action="store_true", help="Collect without a publication-date filter.")
    parser.add_argument("--min-score", type=float, default=None)
    parser.add_argument("--rows-per-query", type=int, default=1000)
    parser.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="Crossref pages per query. In all-time mode this is pages per journal/year. Default: 1, or 10 with --all-time.",
    )
    parser.add_argument("--start-year", type=int, default=None, help="Optional lower year bound for all-time collection.")
    parser.add_argument("--pause-seconds", type=float, default=None, help="Pause between Crossref requests.")
    parser.add_argument("--output-dir", default="reports/tier_i_2months")
    parser.add_argument("--filename-prefix", default="tier_i_2month")
    parser.add_argument("--progress", action=argparse.BooleanOptionalAction, default=True)
    args = parser.parse_args()

    config_dir = Path(args.config_dir)
    today = date.today()
    from_date = None if args.all_time else today - timedelta(days=args.days)
    until_date = None if args.all_time else today
    max_pages = args.max_pages if args.max_pages is not None else (10 if args.all_time else 1)
    pause_seconds = args.pause_seconds if args.pause_seconds is not None else (0.15 if args.all_time else 0.8)

    lab_profile = load_lab_profile(config_dir, args.lab_profile_file)
    journals = load_journals(config_dir, args.journals_file)
    rubric = load_optional_yaml(config_dir, args.rubric_file)
    feedback_records = load_feedback_records(config_dir / args.feedback_file)
    group_adjustments = learn_group_adjustments(feedback_records, rubric)

    collector = CrossrefCollector(pause_seconds=pause_seconds)
    progress_callback = (
        (lambda message: print(message, file=sys.stderr, flush=True))
        if args.progress
        else None
    )
    if args.all_time:
        papers = collector.fetch_all_by_year(
            journals=journals,
            rows_per_query=args.rows_per_query,
            max_pages_per_year=max_pages,
            start_year=args.start_year,
            until_year=today.year,
            progress_callback=progress_callback,
        )
    else:
        papers = collector.fetch_recent(
            journals=journals,
            from_date=from_date,
            until_date=until_date,
            rows_per_query=args.rows_per_query,
            max_pages=max_pages,
            progress_callback=progress_callback,
        )
    scored = score_papers(
        papers=papers,
        lab_profile=lab_profile,
        journals=journals,
        rubric=rubric,
        group_adjustments=group_adjustments,
        apply_threshold=False,
    )
    scored = apply_feedback_adjustments(scored, feedback_records, rubric)

    min_score = args.min_score
    if min_score is None:
        min_score = float(lab_profile.get("report", {}).get("include_threshold", 5))
    selected = [
        item
        for item in scored
        if item.score >= min_score and item.priority not in {"exclude", "not_relevant"}
    ]

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    outline_path = output_dir / f"{args.filename_prefix}_outline_{today.isoformat()}.csv"
    table_path = output_dir / f"{args.filename_prefix}_table_{today.isoformat()}.csv"

    write_outline_csv(outline_path, selected, journals, rubric, from_date, until_date)
    write_table_csv(table_path, selected, journals, rubric, from_date, until_date)

    print(f"Date range: {_format_range_start(from_date)} to {_format_range_end(until_date)}")
    if args.all_time:
        print(f"All-time collection: year-window offset scan")
        print(f"Start year: {args.start_year or 'journal defaults'}")
        print(f"Max pages per journal/year query: {max_pages}")
    else:
        print(f"Max pages per journal query: {max_pages}")
    print(f"Collected papers: {len(papers)}")
    print(f"Selected papers: {len(selected)}")
    print(f"Outline CSV: {outline_path}")
    print(f"Table CSV: {table_path}")


def write_outline_csv(
    path: Path,
    scored_papers: list[ScoredPaper],
    journals: list[Journal],
    rubric: dict[str, Any],
    from_date: date | None,
    until_date: date | None,
) -> None:
    grouped = _group_by_journal_and_issue(scored_papers, journals)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["row_type", "journal", "issue_or_date", "title", "authors", "score", "priority", "themes", "doi", "url"])
        writer.writerow(["metadata", "", f"{_format_range_start(from_date)} ~ {_format_range_end(until_date)}", "", "", "", "", "", "", ""])
        for journal in journals:
            journal_groups = grouped.get(journal.name, {})
            if not journal_groups:
                continue
            writer.writerow(["journal", journal.name, "", "", "", "", "", "", "", ""])
            for issue_key, items in journal_groups.items():
                writer.writerow(["issue", journal.name, issue_key, "", "", "", "", "", "", ""])
                for item in items:
                    paper = item.paper
                    writer.writerow(
                        [
                            "article",
                            paper.journal,
                            _format_article_date(paper.published_date),
                            _clean_text(paper.title),
                            _format_authors(paper.authors),
                            item.score,
                            priority_display(item.priority, rubric),
                            "; ".join(item.matched_themes),
                            paper.doi,
                            paper.url or (f"https://doi.org/{paper.doi}" if paper.doi else ""),
                        ]
                    )


def write_table_csv(
    path: Path,
    scored_papers: list[ScoredPaper],
    journals: list[Journal],
    rubric: dict[str, Any],
    from_date: date | None,
    until_date: date | None,
) -> None:
    journal_order = {journal.name: index for index, journal in enumerate(journals)}
    rows = sorted(
        scored_papers,
        key=lambda item: (
            journal_order.get(item.paper.journal, 999),
            -_date_sort_value(item),
            -item.score,
        ),
    )
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "range_start",
                "range_end",
                "journal",
                "volume",
                "issue",
                "issue_heading",
                "published_date",
                "title",
                "authors",
                "score",
                "priority",
                "lab_relevance",
                "themes",
                "matched_groups",
                "matched_terms",
                "doi",
                "url",
                "review_o",
                "review_x",
                "training_label",
                "reviewer_notes",
            ],
        )
        writer.writeheader()
        for item in rows:
            paper = item.paper
            writer.writerow(
                {
                    "range_start": _format_range_start(from_date),
                    "range_end": _format_range_end(until_date),
                    "journal": paper.journal,
                    "volume": paper.volume,
                    "issue": paper.issue,
                    "issue_heading": _issue_heading(item),
                    "published_date": paper.published_date.isoformat() if paper.published_date else "",
                    "title": _clean_text(paper.title),
                    "authors": _format_authors(paper.authors),
                    "score": item.score,
                    "priority": priority_display(item.priority, rubric),
                    "lab_relevance": item.lab_relevance,
                    "themes": "; ".join(item.matched_themes),
                    "matched_groups": "; ".join(item.matched_groups),
                    "matched_terms": _format_matched_terms(item),
                    "doi": paper.doi,
                    "url": paper.url or (f"https://doi.org/{paper.doi}" if paper.doi else ""),
                    "review_o": "",
                    "review_x": "",
                    "training_label": "",
                    "reviewer_notes": "",
                }
            )


def _group_by_journal_and_issue(
    scored_papers: list[ScoredPaper],
    journals: list[Journal],
) -> dict[str, dict[str, list[ScoredPaper]]]:
    journal_order = {journal.name: index for index, journal in enumerate(journals)}
    sorted_items = sorted(
        scored_papers,
        key=lambda item: (
            journal_order.get(item.paper.journal, 999),
            -_date_sort_value(item),
            -item.score,
        ),
    )
    grouped: dict[str, dict[str, list[ScoredPaper]]] = defaultdict(lambda: defaultdict(list))
    for item in sorted_items:
        grouped[item.paper.journal][_issue_heading(item)].append(item)
    return grouped


def _issue_heading(item: ScoredPaper) -> str:
    paper = item.paper
    month = paper.published_date.strftime("%b %Y") if paper.published_date else "Unknown date"
    parts = []
    if paper.volume:
        parts.append(f"Volume {paper.volume}")
    if paper.issue:
        parts.append(f"Issue {paper.issue}")
    parts.append(month)
    return ", ".join(parts)


def _format_article_date(value: date | None) -> str:
    return value.strftime("%d %b %Y") if value else ""


def _format_range_start(value: date | None) -> str:
    return value.isoformat() if value else "all-time"


def _format_range_end(value: date | None) -> str:
    return value.isoformat() if value else "current"


def _date_sort_value(item: ScoredPaper) -> int:
    if not item.paper.published_date:
        return 0
    return item.paper.published_date.toordinal()


def _format_authors(authors: list[str]) -> str:
    if not authors:
        return ""
    if len(authors) <= 4:
        return ", ".join(authors)
    return f"{authors[0]}, {authors[1]}, ..., {authors[-1]}"


def _format_matched_terms(item: ScoredPaper) -> str:
    chunks = []
    for group, terms in item.matched_groups.items():
        chunks.append(f"{group}: {', '.join(terms[:8])}")
    return " | ".join(chunks)


def _clean_text(value: str) -> str:
    return " ".join(html.unescape(value).split())


if __name__ == "__main__":
    main()
