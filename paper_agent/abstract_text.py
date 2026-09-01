from __future__ import annotations

import re


LEADING_ABSTRACT_LABEL_RE = re.compile(
    r"^\s*abstract\b(?:\s*[:：.\-–—]\s*|\s+|$)",
    re.IGNORECASE,
)


def strip_leading_abstract_label(value: str) -> str:
    """Remove a publisher-supplied Abstract heading at the start of the text."""
    text = str(value or "").strip()
    return LEADING_ABSTRACT_LABEL_RE.sub("", text, count=1).strip()


def compatible_abstract_texts(value: str) -> tuple[str, ...]:
    """Return heading variants that may have been used for an existing translation hash."""
    text = " ".join(str(value or "").split())
    body = strip_leading_abstract_label(text)
    variants = [text, body]
    if body:
        variants.extend(
            [
                f"Abstract {body}",
                f"Abstract: {body}",
                f"ABSTRACT {body}",
                f"ABSTRACT: {body}",
            ]
        )
    return tuple(dict.fromkeys(variant for variant in variants if variant))
