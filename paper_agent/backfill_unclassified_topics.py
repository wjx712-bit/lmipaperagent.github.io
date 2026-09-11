"""Fill only empty topic lists using existing rules and the exported English abstract."""
from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import io
import json
import os
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import yaml

from paper_agent.models import Paper
from paper_agent.relevance import score_paper

UNCLASSIFIED = "\ubbf8\ubd84\ub958"


def plan_backfill(payload, catalog_rows, profile, rubric):
    papers = payload["papers"]
    ids = [paper.get("id") for paper in papers]
    if any(not isinstance(value, str) or not value.strip() for value in ids) or len(set(ids)) != len(ids):
        raise ValueError("Public paper IDs must be nonempty and unique")
    if any(not isinstance(paper.get("topics"), list) for paper in papers):
        raise ValueError("Public topics must be lists")
    by_doi = {}
    for index, row in enumerate(catalog_rows):
        by_doi.setdefault(row.get("doi", "").strip().lower(), []).append(index)
    updated_payload = copy.deepcopy(payload)
    updated_rows = copy.deepcopy(catalog_rows)
    assignments = []
    for paper in updated_payload["papers"]:
        # Explicit unclassified labels are already processed, not new targets.
        if paper["topics"]:
            continue
        doi = paper.get("doi", "").strip().lower()
        indices = by_doi.get(doi, [])
        if not doi or len(indices) != 1:
            raise ValueError(f"Expected exactly one catalog row for {paper['id']}")
        row = updated_rows[indices[0]]
        if row.get("themes", "").strip():
            raise ValueError(f"Catalog already has topics for {doi}; refusing to overwrite")
        scored = score_paper(
            Paper(title=paper["title"], journal=paper["journal"], doi=doi,
                  url=paper.get("url", ""), published_date=None, abstract=paper.get("abstract", "")),
            profile, rubric=rubric,
        )
        topics = list(scored.matched_themes) or [UNCLASSIFIED]
        paper["topics"] = topics
        row["themes"] = "; ".join(topics)
        assignments.append({
            "paperId": paper["id"], "doi": doi, "title": paper["title"],
            "oldTopics": [], "newTopics": topics, "matchedGroups": scored.matched_groups,
            "abstractSha256": hashlib.sha256(paper.get("abstract", "").encode("utf-8")).hexdigest(),
        })
    before = Counter(topic for paper in papers for topic in paper["topics"])
    after = Counter(topic for paper in updated_payload["papers"] for topic in paper["topics"])
    labels = [theme["display"] for theme in rubric.get("themes", {}).values()] + [UNCLASSIFIED]
    report = {
        "version": "empty-topics-backfill-1", "applied": False,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "method": "Existing keyword rules on title and final English abstract; not the experimental preview classifier.",
        "interpretation": "Topic routing only, not verified lab relevance or a replacement for member reviews.",
        "summary": {
            "total": len(papers), "untouched": len(papers) - len(assignments),
            "updated": len(assignments),
            "newlyClassified": sum(item["newTopics"] != [UNCLASSIFIED] for item in assignments),
            "newlyUnclassifiedGroup": sum(item["newTopics"] == [UNCLASSIFIED] for item in assignments),
            "topics": [{"topic": label, "before": before[label], "added": after[label] - before[label],
                        "after": after[label]} for label in labels],
        },
        "assignments": assignments,
    }
    return updated_payload, updated_rows, report


def replace_files(updates, expected):
    """Stage every output first; restore our own writes if any replacement fails."""
    staged = {}
    replaced = []
    try:
        for path, content in updates.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".topic-backfill-", delete=False) as handle:
                staged[path] = Path(handle.name)
                handle.write(content)
        for path, original in expected.items():
            current = path.read_bytes() if path.exists() else None
            if current != original:
                raise ValueError(f"Input changed or report already exists: {path}")
        for path, temporary in staged.items():
            os.replace(temporary, path)
            replaced.append(path)
    except Exception:
        for path in reversed(replaced):
            # Do not overwrite a concurrent external edit during recovery.
            if path.read_bytes() != updates[path]:
                raise RuntimeError(f"Concurrent edit during recovery; inspect {path}")
            original = expected[path]
            if original is None:
                path.unlink()
            else:
                path.write_bytes(original)
        raise
    finally:
        for temporary in staged.values():
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--papers-file", default="public/data/papers.json")
    parser.add_argument("--catalog-file", default="data/catalog/papers_table.csv")
    parser.add_argument("--config-dir", default="config")
    parser.add_argument("--report-file", default="data/topic_backfills/empty-topics-2026-09-10.json")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--expected-site-sha256")
    parser.add_argument("--expected-assigned", type=int)
    parser.add_argument("--expected-unclassified", type=int)
    args = parser.parse_args()
    site, catalog, report_path = map(Path, (args.papers_file, args.catalog_file, args.report_file))
    profile_path = Path(args.config_dir) / "lab_profile.yml"
    rubric_path = Path(args.config_dir) / "relevance_rubric.yml"
    if len({path.resolve() for path in (site, catalog, report_path, profile_path, rubric_path)}) != 5:
        raise ValueError("Input and output paths must be distinct")
    raw = {path: path.read_bytes() for path in (site, catalog, profile_path, rubric_path)}
    hashes = {str(path): hashlib.sha256(content).hexdigest() for path, content in raw.items()}
    if args.apply and not args.expected_site_sha256:
        raise ValueError("Applying requires --expected-site-sha256 from the reviewed snapshot")
    if args.expected_site_sha256 and args.expected_site_sha256.lower() != hashes[str(site)]:
        raise ValueError("Public snapshot differs from the reviewed input")
    reader = csv.DictReader(io.StringIO(raw[catalog].decode("utf-8-sig"), newline=""))
    rows = list(reader)
    if "themes" not in (reader.fieldnames or []):
        raise ValueError("Catalog has no themes column")
    payload, updated_rows, report = plan_backfill(
        json.loads(raw[site]), rows,
        yaml.safe_load(raw[profile_path]), yaml.safe_load(raw[rubric_path]),
    )
    report["inputSha256"] = hashes
    summary = report["summary"]
    for expected, actual in [(args.expected_assigned, summary["newlyClassified"]),
                             (args.expected_unclassified, summary["newlyUnclassifiedGroup"])]:
        if expected is not None and expected != actual:
            raise ValueError("Result counts differ from the reviewed plan")
    if args.apply and summary["updated"]:
        csv_output = io.StringIO(newline="")
        writer = csv.DictWriter(csv_output, fieldnames=reader.fieldnames)
        writer.writeheader()
        writer.writerows(updated_rows)
        report["applied"] = True
        outputs = {
            catalog: csv_output.getvalue().encode("utf-8-sig"),
            site: json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            report_path: json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8"),
        }
        replace_files(outputs, {**raw, report_path: None})
    print(json.dumps({"applied": report["applied"], "summary": summary,
                      "inputSha256": hashes}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
