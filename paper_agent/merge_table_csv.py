from __future__ import annotations

import argparse
import csv
import os
import shutil
from pathlib import Path
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge exported table CSV files by DOI/title key.")
    parser.add_argument("--base", required=True)
    parser.add_argument("--supplement", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--backup", default="")
    args = parser.parse_args()

    base_path = Path(args.base)
    supplement_path = Path(args.supplement)
    output_path = Path(args.output)
    if args.backup:
        shutil.copy2(base_path, args.backup)

    result = merge_table_files(
        base_path=base_path,
        supplement_path=supplement_path,
        output_path=output_path,
    )

    print(f"Base rows: {result['base_rows']}")
    print(f"Supplement rows: {result['supplement_rows']}")
    print(f"Merged rows: {result['merged_rows']}")
    print(f"Output: {output_path}")


def merge_table_files(
    base_path: Path,
    supplement_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    base_rows, base_fields = read_table_rows(base_path)
    supplement_rows, supplement_fields = read_table_rows(supplement_path)
    fieldnames = list(dict.fromkeys([*base_fields, *supplement_fields]))

    merged: dict[str, dict[str, str]] = {}
    for row in [*base_rows, *supplement_rows]:
        key = row_key(row)
        existing = merged.get(key)
        if existing is None or _score(row) > _score(existing):
            merged[key] = row

    rows = sorted(
        merged.values(),
        key=lambda row: (
            row.get("journal", ""),
            row.get("published_date", ""),
            _score(row),
        ),
        reverse=True,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_path = output_path.with_name(output_path.name + ".tmp")
    with write_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(write_path, output_path)
    return {
        "base_rows": len(base_rows),
        "supplement_rows": len(supplement_rows),
        "merged_rows": len(rows),
        "fieldnames": fieldnames,
    }


def read_table_rows(path: Path) -> tuple[list[dict[str, str]], list[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader), list(reader.fieldnames or [])


def row_key(row: dict[str, str]) -> str:
    doi = (row.get("doi") or "").strip().lower()
    if doi:
        return f"doi:{doi}"
    return "title:" + "|".join(
        [
            (row.get("journal") or "").strip().lower(),
            (row.get("published_date") or "").strip(),
            (row.get("title") or "").strip().lower(),
        ]
    )


def _score(row: dict[str, str]) -> float:
    try:
        return float(row.get("score") or 0)
    except ValueError:
        return 0.0


if __name__ == "__main__":
    main()
