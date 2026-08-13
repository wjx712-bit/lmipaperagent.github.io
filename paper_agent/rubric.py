from __future__ import annotations

from typing import Any


DEFAULT_PRIORITY_LEVELS = [
    {"label": "must_read", "display": "Must read", "min_score": 18, "lab_relevance": 3},
    {"label": "worth_scanning", "display": "Worth scanning", "min_score": 10, "lab_relevance": 2},
    {"label": "archive_only", "display": "Archive only", "min_score": 0, "lab_relevance": 1},
]


def classify_score(score: float, rubric: dict[str, Any] | None = None) -> tuple[str, int]:
    levels = (rubric or {}).get("priority_levels") or DEFAULT_PRIORITY_LEVELS
    sorted_levels = sorted(levels, key=lambda item: float(item.get("min_score", 0)), reverse=True)
    for level in sorted_levels:
        if score >= float(level.get("min_score", 0)):
            return str(level.get("label", "archive_only")), int(level.get("lab_relevance", 1))
    return "not_relevant", 0


def priority_display(label: str, rubric: dict[str, Any] | None = None) -> str:
    levels = (rubric or {}).get("priority_levels") or DEFAULT_PRIORITY_LEVELS
    for level in levels:
        if level.get("label") == label:
            return str(level.get("display") or label)
    feedback_labels = (rubric or {}).get("feedback_labels", {})
    if label in feedback_labels:
        return str(feedback_labels[label].get("display") or label)
    return label.replace("_", " ").title()


def themes_for_groups(
    matched_groups: dict[str, list[str]],
    rubric: dict[str, Any] | None = None,
) -> list[str]:
    group_names = set(matched_groups)
    themes = []
    for theme_id, theme_config in (rubric or {}).get("themes", {}).items():
        theme_groups = set(theme_config.get("keyword_groups") or [])
        if group_names.intersection(theme_groups):
            themes.append(str(theme_config.get("display") or theme_id))
    return themes
