from __future__ import annotations

import re
from typing import Any

from paper_agent.models import Journal, Paper, ScoredPaper
from paper_agent.rubric import classify_score, themes_for_groups


def score_papers(
    papers: list[Paper],
    lab_profile: dict[str, Any],
    journals: list[Journal],
    rubric: dict[str, Any] | None = None,
    group_adjustments: dict[str, float] | None = None,
    apply_threshold: bool = True,
) -> list[ScoredPaper]:
    journal_weights = {journal.name.lower(): journal.priority_weight for journal in journals}
    scored = [
        score_paper(
            paper=paper,
            lab_profile=lab_profile,
            journal_priority=journal_weights.get(paper.journal.lower(), 0),
            rubric=rubric,
            group_adjustments=group_adjustments,
        )
        for paper in papers
    ]
    threshold = float(lab_profile.get("report", {}).get("include_threshold", 0))
    if not apply_threshold:
        return sorted(scored, key=lambda item: (item.score, item.paper.published_date or ""), reverse=True)
    return sorted(
        [item for item in scored if item.score >= threshold],
        key=lambda item: (item.score, item.paper.published_date or ""),
        reverse=True,
    )


def score_paper(
    paper: Paper,
    lab_profile: dict[str, Any],
    journal_priority: int = 0,
    rubric: dict[str, Any] | None = None,
    group_adjustments: dict[str, float] | None = None,
) -> ScoredPaper:
    scoring_config = lab_profile.get("scoring", {})
    title_multiplier = float(scoring_config.get("title_multiplier", 2.0))
    abstract_multiplier = float(scoring_config.get("abstract_multiplier", 1.0))
    journal_multiplier = float(scoring_config.get("journal_priority_multiplier", 1.0))

    title = paper.title.lower()
    abstract = paper.abstract.lower()
    matched_groups: dict[str, list[str]] = {}
    score = journal_priority * journal_multiplier
    group_adjustments = group_adjustments or {}

    for group_name, group_config in lab_profile.get("keyword_groups", {}).items():
        group_weight = float(group_config.get("weight", 1)) + float(group_adjustments.get(group_name, 0))
        group_weight = max(group_weight, 0)
        matches: list[str] = []
        for term in group_config.get("terms", []):
            term_text = str(term).lower()
            if not term_text:
                continue
            title_hits = _count_term(title, term_text)
            abstract_hits = _count_term(abstract, term_text)
            if title_hits or abstract_hits:
                matches.append(str(term))
                score += group_weight * (
                    title_hits * title_multiplier + min(abstract_hits, 2) * abstract_multiplier
                )
        if matches:
            matched_groups[group_name] = sorted(set(matches))

    for keyword in lab_profile.get("negative_keywords", []):
        if str(keyword).lower() in title or str(keyword).lower() in abstract:
            score -= 3

    reason = _build_reason(matched_groups)
    priority, lab_relevance = classify_score(score, rubric)
    matched_themes = themes_for_groups(matched_groups, rubric)
    return ScoredPaper(
        paper=paper,
        score=round(score, 2),
        matched_groups=matched_groups,
        reason=reason,
        priority=priority,
        lab_relevance=lab_relevance,
        matched_themes=matched_themes,
    )


def _count_term(text: str, term: str) -> int:
    if not text or not term:
        return 0
    text = text.lower()
    term = term.lower()
    tokens = re.findall(r"[a-z0-9]+", term.lower())
    if not tokens:
        return 0
    if len(tokens) == 1:
        pattern = rf"\b{re.escape(tokens[0])}\b"
        return len(re.findall(pattern, text))

    token_patterns = [re.escape(token) for token in tokens]
    if token_patterns[-1] in {"cell", "adipocyte", "macrophage", "hepatocyte", "lymphocyte"}:
        token_patterns[-1] = f"{token_patterns[-1]}s?"
    pattern = r"(?<![a-z0-9])" + r"[\W_]+".join(token_patterns) + r"(?![a-z0-9])"
    return len(re.findall(pattern, text))


def _build_reason(matched_groups: dict[str, list[str]]) -> str:
    if not matched_groups:
        return "저널 우선순위 기반 후보"
    labels = []
    for group_name, terms in matched_groups.items():
        preview = ", ".join(terms[:3])
        labels.append(f"{group_name}: {preview}")
    return "; ".join(labels)
