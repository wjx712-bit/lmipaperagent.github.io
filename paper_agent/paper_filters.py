from __future__ import annotations

import re


EXCLUDED_TITLE_PREFIXES = (
    "author correction:",
    "publisher correction:",
    "correction:",
    "correction to:",
    "corrigendum:",
    "erratum:",
    "retraction note:",
    "retracted:",
)
CONFERENCE_ABSTRACT_RE = re.compile(r"^(FRI|SAT|WED|THU|TOP|OS|LBP)-\d+(?:-YI)?\s", re.IGNORECASE)


def is_excluded_publication(title: str, doi: str = "") -> bool:
    normalized = " ".join(title.lower().split())
    normalized_doi = doi.strip().lower()
    return (
        normalized.startswith(EXCLUDED_TITLE_PREFIXES)
        or bool(CONFERENCE_ABSTRACT_RE.match(title.strip()))
        or normalized_doi.startswith("10.1038/d41586-")
    )
