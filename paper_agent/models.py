from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass(frozen=True)
class Journal:
    name: str
    tier: str
    priority_weight: int
    query_titles: list[str]
    aliases: list[str] = field(default_factory=list)
    issns: list[str] = field(default_factory=list)
    start_year: int | None = None
    active: bool = True
    needs_confirmation: bool = False
    note: str = ""


@dataclass
class Paper:
    title: str
    journal: str
    doi: str
    url: str
    published_date: date | None
    authors: list[str] = field(default_factory=list)
    abstract: str = ""
    volume: str = ""
    issue: str = ""
    source: str = "crossref"

    @property
    def stable_id(self) -> str:
        if self.doi:
            return self.doi.lower()
        return f"{self.journal}:{self.title}".lower()


@dataclass
class ScoredPaper:
    paper: Paper
    score: float
    matched_groups: dict[str, list[str]]
    reason: str
    priority: str = "archive_only"
    lab_relevance: int = 1
    matched_themes: list[str] = field(default_factory=list)
    feedback_label: str = ""
    feedback_note: str = ""
