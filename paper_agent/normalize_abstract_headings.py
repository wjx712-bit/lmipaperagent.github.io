from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path

from paper_agent.abstract_text import strip_leading_abstract_label


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Remove publisher-supplied Abstract headings from stored abstracts."
    )
    parser.add_argument("--catalog-file", default="data/catalog/papers_table.csv")
    parser.add_argument("--source-index", default="data/paper_analysis/source_index.json")
    args = parser.parse_args()

    catalog_count = normalize_catalog(Path(args.catalog_file))
    source_count = normalize_source_index(Path(args.source_index))
    print(f"Catalog abstracts normalized: {catalog_count}")
    print(f"Source-index abstracts normalized: {source_count}")


def normalize_catalog(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    changed = 0
    for row in rows:
        current = row.get("abstract", "")
        normalized = strip_leading_abstract_label(current)
        if normalized != current:
            row["abstract"] = normalized
            changed += 1

    if changed:
        temporary = path.with_name(path.name + ".tmp")
        with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
        os.replace(temporary, path)
    return changed


def normalize_source_index(path: Path) -> int:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    changed = 0
    for source in payload.get("papers", {}).values():
        current = str(source.get("abstract") or "")
        normalized = strip_leading_abstract_label(current)
        if normalized == current:
            continue
        source["abstract"] = normalized
        if "abstractCharacters" in source:
            source["abstractCharacters"] = len(normalized)
        changed += 1

    if changed:
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, path)
    return changed


if __name__ == "__main__":
    main()
