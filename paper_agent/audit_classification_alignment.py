"""Read-only replay of current classification rules on the final exported abstract."""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import yaml

from paper_agent.models import Paper
from paper_agent.relevance import score_paper
from paper_agent.rubric import priority_display


def audit_alignment(papers, profile, journals, rubric):
    weights = {journal["name"]: journal["priority_weight"] for journal in journals}
    counts = Counter(total=len(papers), topic_drift=0, score_drift=0, priority_drift=0,
                     added_topic_memberships=0, removed_topic_memberships=0,
                     unclassified_with_replayed_topics=0)
    changed = []
    for paper in papers:
        scored = score_paper(
            Paper(title=paper["title"], journal=paper["journal"], doi=paper.get("doi", ""),
                  url=paper.get("url", ""), published_date=None,
                  abstract=paper.get("abstract", "")),
            profile, weights.get(paper["journal"], 0), rubric,
        )
        stored = set(paper.get("topics", []))
        replayed = set(scored.matched_themes)
        counts["topic_drift"] += stored != replayed
        counts["score_drift"] += paper.get("relevanceRaw") != scored.score
        counts["priority_drift"] += paper.get("priority") != priority_display(scored.priority, rubric)
        counts["added_topic_memberships"] += len(replayed - stored)
        counts["removed_topic_memberships"] += len(stored - replayed)
        counts["unclassified_with_replayed_topics"] += not stored and bool(replayed)
        if stored != replayed:
            changed.append({"paper_id": paper["id"], "doi": paper.get("doi"),
                            "stored_topics": sorted(stored), "replayed_topics": sorted(replayed)})
    return {"counts": dict(counts), "changed": changed,
            "interpretation": "Rule replay differences only, not validated topic corrections. No records modified."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--papers-file", default="public/data/papers.json")
    parser.add_argument("--config-dir", default="config")
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()
    paths = [Path(args.papers_file)] + [Path(args.config_dir) / name for name in
                                      ("lab_profile.yml", "journals.yml", "relevance_rubric.yml")]
    dataset = json.loads(paths[0].read_text(encoding="utf-8-sig"))
    profile, journals, rubric = [yaml.safe_load(path.read_text(encoding="utf-8-sig")) for path in paths[1:]]
    report = audit_alignment(dataset["papers"], profile, journals["journals"], rubric)
    if args.summary_only:
        report.pop("changed")
    report["input_sha256"] = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
