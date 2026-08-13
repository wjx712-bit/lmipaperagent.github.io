from __future__ import annotations

import csv
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from paper_agent.models import ScoredPaper
from paper_agent.rubric import classify_score


@dataclass(frozen=True)
class FeedbackRecord:
    stable_id: str
    doi: str
    title: str
    journal: str
    label: str
    relevance_score: str
    theme_tags: list[str]
    matched_groups: list[str]
    notes: str


def load_feedback_records(path: Path) -> dict[str, FeedbackRecord]:
    if not path.exists():
        return {}

    records: dict[str, FeedbackRecord] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            record = FeedbackRecord(
                stable_id=str(row.get("stable_id") or "").strip().lower(),
                doi=str(row.get("doi") or "").strip().lower(),
                title=str(row.get("title") or "").strip(),
                journal=str(row.get("journal") or "").strip(),
                label=_normalize_label(row.get("label") or ""),
                relevance_score=str(row.get("relevance_score") or "").strip(),
                theme_tags=_split_list(row.get("theme_tags") or ""),
                matched_groups=_split_list(row.get("matched_groups") or ""),
                notes=str(row.get("notes") or "").strip(),
            )
            if not record.label and not record.relevance_score:
                continue
            for key in (record.stable_id, record.doi):
                if key:
                    records[key] = record
    return records


def learn_group_adjustments(
    feedback_records: dict[str, FeedbackRecord],
    rubric: dict[str, Any] | None = None,
) -> dict[str, float]:
    learning_config = (rubric or {}).get("feedback_learning", {})
    if not learning_config.get("enabled", True):
        return {}

    label_deltas = learning_config.get(
        "label_group_delta",
        {
            "must_read": 1.5,
            "worth_scanning": 0.5,
            "archive_only": -0.4,
            "not_relevant": -1.2,
            "exclude": -2.0,
        },
    )
    min_adjustment = float(learning_config.get("min_group_adjustment", -3))
    max_adjustment = float(learning_config.get("max_group_adjustment", 3))

    totals: dict[str, float] = {}
    counts: dict[str, int] = {}
    for record in feedback_records.values():
        delta = label_deltas.get(record.label)
        if delta is None:
            continue
        for group in record.matched_groups:
            totals[group] = totals.get(group, 0.0) + float(delta)
            counts[group] = counts.get(group, 0) + 1

    adjustments: dict[str, float] = {}
    for group, total in totals.items():
        averaged = total / max(counts.get(group, 1), 1)
        adjustments[group] = min(max(averaged, min_adjustment), max_adjustment)
    return adjustments


def apply_feedback_adjustments(
    scored_papers: list[ScoredPaper],
    feedback_records: dict[str, FeedbackRecord],
    rubric: dict[str, Any] | None = None,
) -> list[ScoredPaper]:
    feedback_config = (rubric or {}).get("feedback_learning", {})
    score_adjustments = feedback_config.get(
        "exact_label_score_adjustment",
        {
            "must_read": 100,
            "worth_scanning": 20,
            "archive_only": -4,
            "not_relevant": -100,
            "exclude": -1000,
        },
    )

    adjusted: list[ScoredPaper] = []
    for item in scored_papers:
        record = _find_feedback_record(item, feedback_records)
        if not record:
            adjusted.append(item)
            continue

        score = item.score + float(score_adjustments.get(record.label, 0))
        priority, relevance = classify_score(score, rubric)
        if record.label in {"must_read", "worth_scanning", "archive_only", "not_relevant", "exclude"}:
            priority = record.label
        if record.relevance_score.isdigit():
            relevance = int(record.relevance_score)

        reason = item.reason
        if record.notes:
            reason = f"{reason}; feedback: {record.label} ({record.notes})"
        else:
            reason = f"{reason}; feedback: {record.label}"

        adjusted.append(
            replace(
                item,
                score=round(score, 2),
                priority=priority,
                lab_relevance=relevance,
                feedback_label=record.label,
                feedback_note=record.notes,
                reason=reason,
            )
        )
    return adjusted


def write_feedback_queue(scored_papers: list[ScoredPaper], path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "stable_id",
        "doi",
        "title",
        "journal",
        "score",
        "suggested_priority",
        "lab_relevance",
        "theme_tags",
        "matched_groups",
        "matched_terms",
        "label",
        "relevance_score",
        "notes",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for item in scored_papers:
            writer.writerow(
                {
                    "stable_id": item.paper.stable_id,
                    "doi": item.paper.doi,
                    "title": item.paper.title,
                    "journal": item.paper.journal,
                    "score": item.score,
                    "suggested_priority": item.priority,
                    "lab_relevance": item.lab_relevance,
                    "theme_tags": "; ".join(item.matched_themes),
                    "matched_groups": "; ".join(item.matched_groups),
                    "matched_terms": _format_matched_terms(item),
                    "label": "",
                    "relevance_score": "",
                    "notes": "",
                }
            )
    return path


def _find_feedback_record(
    item: ScoredPaper,
    feedback_records: dict[str, FeedbackRecord],
) -> FeedbackRecord | None:
    for key in (item.paper.stable_id.lower(), item.paper.doi.lower()):
        if key and key in feedback_records:
            return feedback_records[key]
    return None


def _normalize_label(label: str) -> str:
    return label.strip().lower().replace("-", "_").replace(" ", "_")


def _split_list(value: str) -> list[str]:
    normalized = value.replace(",", ";")
    return [part.strip() for part in normalized.split(";") if part.strip()]


def _format_matched_terms(item: ScoredPaper) -> str:
    chunks = []
    for group, terms in item.matched_groups.items():
        chunks.append(f"{group}: {', '.join(terms[:6])}")
    return " | ".join(chunks)
