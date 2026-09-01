from __future__ import annotations

import argparse
import csv
import os
from datetime import date
from pathlib import Path

from paper_agent.config import load_journals, load_lab_profile, load_optional_yaml
from paper_agent.models import Paper
from paper_agent.relevance import score_paper
from paper_agent.rubric import priority_display


def main() -> None:
    parser = argparse.ArgumentParser(description="Reapply the current LMI rubric to a catalog CSV.")
    parser.add_argument("--config-dir", default="config")
    parser.add_argument("--catalog-file", default="data/catalog/papers_table.csv")
    args = parser.parse_args()

    config_dir = Path(args.config_dir)
    catalog_path = Path(args.catalog_file)
    lab_profile = load_lab_profile(config_dir, "lab_profile.yml")
    journals = load_journals(config_dir, "journals.yml")
    rubric = load_optional_yaml(config_dir, "relevance_rubric.yml")
    journal_weights = {journal.name.lower(): journal.priority_weight for journal in journals}

    with catalog_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    for row in rows:
        paper = paper_from_row(row)
        scored = score_paper(
            paper,
            lab_profile,
            journal_priority=journal_weights.get(paper.journal.lower(), 0),
            rubric=rubric,
        )
        row["score"] = str(scored.score)
        row["priority"] = priority_display(scored.priority, rubric)
        row["lab_relevance"] = str(scored.lab_relevance)
        row["themes"] = "; ".join(scored.matched_themes)
        row["matched_groups"] = "; ".join(scored.matched_groups)
        row["matched_terms"] = " | ".join(
            f"{group}: {', '.join(terms[:8])}"
            for group, terms in scored.matched_groups.items()
        )

    temporary = catalog_path.with_name(catalog_path.name + ".tmp")
    with temporary.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temporary, catalog_path)
    print(f"Catalog rows rescored: {len(rows)}")


def paper_from_row(row: dict[str, str]) -> Paper:
    published = None
    try:
        published = date.fromisoformat((row.get("published_date") or "")[:10])
    except ValueError:
        pass
    return Paper(
        title=row.get("title", ""),
        journal=row.get("journal", ""),
        doi=row.get("doi", ""),
        url=row.get("url", ""),
        published_date=published,
        authors=[part.strip() for part in (row.get("authors") or "").split(",") if part.strip()],
        abstract=row.get("abstract", ""),
        volume=row.get("volume", ""),
        issue=row.get("issue", ""),
    )


if __name__ == "__main__":
    main()
