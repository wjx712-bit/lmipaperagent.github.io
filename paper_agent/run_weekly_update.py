from __future__ import annotations

import argparse
import csv
import json
import os
import shutil
import sys
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from paper_agent.collectors.crossref import CrossrefCollector
from paper_agent.config import load_journals, load_lab_profile, load_optional_yaml
from paper_agent.export_journal_csv import write_table_csv
from paper_agent.feedback import (
    FeedbackRecord,
    apply_feedback_adjustments,
    learn_group_adjustments,
    load_feedback_records,
)
from paper_agent.merge_table_csv import merge_table_files, read_table_rows, row_key
from paper_agent.models import Paper, ScoredPaper
from paper_agent.paper_filters import is_excluded_publication
from paper_agent.relevance import score_papers


DEFAULT_BASELINE_GLOB = "reports/training_seed_alltime/all_journals_alltime_table_*.csv"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect newly published LMI-relevant papers and update the website catalog."
    )
    parser.add_argument("--config-dir", default="config")
    parser.add_argument("--lab-profile-file", default="lab_profile.yml")
    parser.add_argument("--journals-file", default="journals.yml")
    parser.add_argument("--rubric-file", default="relevance_rubric.yml")
    parser.add_argument("--feedback-file", default="feedback_labels.csv")
    parser.add_argument("--web-labels-file", default="data/web_labels.csv")
    parser.add_argument("--baseline-glob", default=DEFAULT_BASELINE_GLOB)
    parser.add_argument("--catalog-file", default="reports/catalog/papers_table.csv")
    parser.add_argument("--reports-dir", default="reports/weekly_updates")
    parser.add_argument("--state-file", default="data/weekly_collection_state.json")
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--min-score", type=float, default=None)
    parser.add_argument("--rows-per-query", type=int, default=1000)
    parser.add_argument("--max-pages", type=int, default=5)
    parser.add_argument("--pause-seconds", type=float, default=0.5)
    parser.add_argument("--mailto", default=os.environ.get("LMI_CROSSREF_MAILTO", ""))
    parser.add_argument("--run-date", type=date.fromisoformat, default=None)
    parser.add_argument(
        "--bootstrap-only",
        action="store_true",
        help="Initialize the cumulative catalog from the all-time dataset without collecting.",
    )
    args = parser.parse_args()

    run_date = args.run_date or date.today()
    catalog_path = Path(args.catalog_file)
    if not catalog_path.exists():
        baseline_path = find_latest_file(args.baseline_glob)
        initialize_catalog(baseline_path, catalog_path)
    if args.bootstrap_only:
        print(f"Catalog initialized: {catalog_path}")
        return

    config_dir = Path(args.config_dir)
    lab_profile = load_lab_profile(config_dir, args.lab_profile_file)
    journals = load_journals(config_dir, args.journals_file)
    rubric = load_optional_yaml(config_dir, args.rubric_file)
    feedback_records = load_combined_feedback(
        [config_dir / args.feedback_file, Path(args.web_labels_file)],
        catalog_path,
    )
    group_adjustments = learn_group_adjustments(feedback_records, rubric)

    from_date = run_date - timedelta(days=max(args.lookback_days, 7))
    collector = CrossrefCollector(
        mailto=args.mailto or None,
        pause_seconds=max(args.pause_seconds, 0),
    )
    papers = collector.fetch_recent(
        journals=journals,
        from_date=from_date,
        until_date=run_date,
        rows_per_query=args.rows_per_query,
        max_pages=args.max_pages,
        progress_callback=lambda message: print(message, file=sys.stderr, flush=True),
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
    threshold = args.min_score
    if threshold is None:
        threshold = float(lab_profile.get("report", {}).get("include_threshold", 5))
    relevant = [
        item
        for item in scored
        if item.score >= threshold
        and item.priority not in {"exclude", "not_relevant"}
        and not is_excluded_publication(item.paper.title, item.paper.doi)
    ]

    known_keys = load_table_keys(catalog_path)
    new_items = [item for item in relevant if paper_key(item.paper) not in known_keys]
    new_items.sort(
        key=lambda item: (item.paper.published_date or date.min, item.score),
        reverse=True,
    )

    reports_dir = Path(args.reports_dir)
    reports_dir.mkdir(parents=True, exist_ok=True)
    batch_path = reports_dir / f"weekly_update_table_{run_date.isoformat()}.csv"
    if new_items:
        new_batch_path = batch_path.with_name(f"{batch_path.stem}_new.csv")
        write_table_csv(new_batch_path, new_items, journals, rubric, from_date, run_date)
        if batch_path.exists():
            merge_table_files(batch_path, new_batch_path, batch_path)
            new_batch_path.unlink(missing_ok=True)
        else:
            os.replace(new_batch_path, batch_path)
        merge_table_files(catalog_path, batch_path, catalog_path)
    elif not batch_path.exists():
        write_table_csv(batch_path, [], journals, rubric, from_date, run_date)
    batch_rows, _ = read_table_rows(batch_path)

    state_path = Path(args.state_file)
    write_state(
        state_path,
        {
            "status": "success",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "run_date": run_date.isoformat(),
            "query_from": from_date.isoformat(),
            "query_until": run_date.isoformat(),
            "collected_count": len(papers),
            "relevant_count": len(relevant),
            "new_count": len(new_items),
            "batch_count": len(batch_rows),
            "feedback_count": len({id(record) for record in feedback_records.values()}),
            "batch_file": str(batch_path),
            "catalog_file": str(catalog_path),
        },
    )

    print(f"Query range: {from_date.isoformat()} to {run_date.isoformat()}")
    print(f"Collected papers: {len(papers)}")
    print(f"Relevant papers: {len(relevant)}")
    print(f"New papers added: {len(new_items)}")
    print(f"Papers in this weekly batch: {len(batch_rows)}")
    print(f"Weekly batch: {batch_path}")
    print(f"Website catalog: {catalog_path}")
    print(f"Run state: {state_path}")


def find_latest_file(pattern: str) -> Path:
    matches = sorted(Path.cwd().glob(pattern), key=lambda path: path.stat().st_mtime, reverse=True)
    if not matches:
        raise FileNotFoundError(f"No baseline dataset matches {pattern}")
    return matches[0]


def initialize_catalog(baseline_path: Path, catalog_path: Path) -> None:
    if catalog_path.exists():
        return
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = catalog_path.with_name(catalog_path.name + ".tmp")
    shutil.copy2(baseline_path, temp_path)
    os.replace(temp_path, catalog_path)


def load_table_keys(path: Path) -> set[str]:
    rows, _ = read_table_rows(path)
    return {row_key(row) for row in rows}


def paper_key(paper: Paper) -> str:
    if paper.doi:
        return f"doi:{paper.doi.strip().lower()}"
    return "title:" + "|".join(
        [
            paper.journal.strip().lower(),
            paper.published_date.isoformat() if paper.published_date else "",
            paper.title.strip().lower(),
        ]
    )


def load_combined_feedback(
    feedback_paths: list[Path],
    catalog_path: Path,
) -> dict[str, FeedbackRecord]:
    catalog_metadata = load_catalog_feedback_metadata(catalog_path)
    combined: dict[str, FeedbackRecord] = {}
    for path in feedback_paths:
        records = load_feedback_records(path)
        unique_records = {id(record): record for record in records.values()}.values()
        for record in unique_records:
            metadata = catalog_metadata.get(record.doi or record.stable_id, {})
            enriched = replace(
                record,
                matched_groups=record.matched_groups or _split_semicolon(metadata.get("matched_groups", "")),
                theme_tags=record.theme_tags or _split_semicolon(metadata.get("themes", "")),
            )
            for key in (enriched.stable_id, enriched.doi):
                if key:
                    combined[key] = enriched
    return combined


def load_catalog_feedback_metadata(path: Path) -> dict[str, dict[str, str]]:
    metadata: dict[str, dict[str, str]] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            doi = (row.get("doi") or "").strip().lower()
            if doi:
                metadata[doi] = row
    return metadata


def write_state(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp_path, path)


def _split_semicolon(value: str) -> list[str]:
    return [part.strip() for part in value.split(";") if part.strip()]


if __name__ == "__main__":
    main()
