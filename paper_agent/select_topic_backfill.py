from __future__ import annotations

import argparse
import csv
import os
from pathlib import Path

from paper_agent.merge_table_csv import row_key
from paper_agent.paper_filters import is_excluded_publication


def main() -> None:
    parser = argparse.ArgumentParser(description="Select a recent topic-specific catalog backfill.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--theme", required=True)
    parser.add_argument("--target-count", type=int, required=True)
    parser.add_argument("--catalog-file", default="")
    parser.add_argument("--pruned-catalog-output", default="")
    args = parser.parse_args()

    count = select_topic_rows(
        input_path=Path(args.input),
        output_path=Path(args.output),
        theme=args.theme,
        target_count=args.target_count,
    )
    print(f"Selected topic rows: {count}")
    print(f"Output: {args.output}")
    if args.catalog_file or args.pruned_catalog_output:
        if not args.catalog_file or not args.pruned_catalog_output:
            parser.error("--catalog-file and --pruned-catalog-output must be provided together")
        kept = prune_catalog_to_topic_selection(
            catalog_path=Path(args.catalog_file),
            selection_path=Path(args.output),
            output_path=Path(args.pruned_catalog_output),
            theme=args.theme,
        )
        print(f"Pruned catalog rows: {kept}")


def select_topic_rows(
    input_path: Path,
    output_path: Path,
    theme: str,
    target_count: int,
) -> int:
    with input_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    matching: dict[str, dict[str, str]] = {}
    for row in rows:
        themes = {part.strip() for part in (row.get("themes") or "").split(";") if part.strip()}
        if theme not in themes:
            continue
        if is_excluded_publication(row.get("title", ""), row.get("doi", "")):
            continue
        key = row_key(row)
        existing = matching.get(key)
        if existing is None or _score(row) > _score(existing):
            matching[key] = row

    selected = sorted(
        matching.values(),
        key=lambda row: (row.get("published_date", ""), _score(row), row.get("title", "")),
        reverse=True,
    )[: max(target_count, 0)]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(output_path.name + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(selected)
    os.replace(temporary, output_path)
    return len(selected)


def prune_catalog_to_topic_selection(
    catalog_path: Path,
    selection_path: Path,
    output_path: Path,
    theme: str,
) -> int:
    with selection_path.open("r", encoding="utf-8-sig", newline="") as handle:
        selected_keys = {row_key(row) for row in csv.DictReader(handle)}
    with catalog_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    kept = []
    for row in rows:
        themes = {part.strip() for part in (row.get("themes") or "").split(";") if part.strip()}
        if theme not in themes or row_key(row) in selected_keys:
            kept.append(row)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(output_path.name + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(kept)
    os.replace(temporary, output_path)
    return len(kept)


def _score(row: dict[str, str]) -> float:
    try:
        return float(row.get("score") or 0)
    except ValueError:
        return 0.0


if __name__ == "__main__":
    main()
