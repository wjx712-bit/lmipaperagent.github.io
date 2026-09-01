from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from paper_agent.abstract_text import compatible_abstract_texts, strip_leading_abstract_label
from paper_agent.paper_filters import is_excluded_publication


JOURNAL_SHORT_NAMES = {
    "Nature": "Nature",
    "Nature Immunology": "Nat Immunol",
    "Nature Communications": "Nat Commun",
    "Nature Aging": "Nat Aging",
    "Science": "Science",
    "Nature Metabolism": "Nat Metab",
    "Journal of Hepatology": "J Hepatol",
    "Cell": "Cell",
    "Cell Metabolism": "Cell Metab",
    "Journal of Clinical Investigation": "JCI",
    "Nature Cell Biology": "Nat Cell Biol",
    "Immunity": "Immunity",
    "Hepatology": "Hepatology",
    "Nature Reviews Endocrinology": "Nat Rev Endocrinol",
}
TAG_RE = re.compile(r"<[^>]+>")


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the LMI catalog for GitHub Pages.")
    parser.add_argument("--catalog-file", default="data/catalog/papers_table.csv")
    parser.add_argument("--state-file", default="data/weekly_collection_state.json")
    parser.add_argument("--recommendations-file", default="config/expert_recommendations.csv")
    parser.add_argument("--source-index", default="data/paper_analysis/source_index.json")
    parser.add_argument("--translations-file", default="data/abstract_translations/ko.json")
    parser.add_argument("--output", default="public/data/papers.json")
    parser.add_argument("--since-days", type=int, default=365)
    parser.add_argument("--as-of", type=date.fromisoformat, default=None)
    parser.add_argument("--include-missing-abstracts", action="store_true")
    args = parser.parse_args()

    payload = build_site_payload(
        catalog_path=Path(args.catalog_file),
        state_path=Path(args.state_file),
        recommendations_path=Path(args.recommendations_file),
        source_index_path=Path(args.source_index),
        translations_path=Path(args.translations_file),
        since_days=args.since_days,
        as_of=args.as_of,
        include_missing_abstracts=args.include_missing_abstracts,
    )
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(output_path.name + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    temp_path.replace(output_path)
    print(f"Website papers: {len(payload['papers'])}")
    print(f"Website data: {output_path}")


def build_site_payload(
    catalog_path: Path,
    state_path: Path | None = None,
    recommendations_path: Path | None = None,
    source_index_path: Path | None = None,
    translations_path: Path | None = None,
    since_days: int = 365,
    as_of: date | None = None,
    include_missing_abstracts: bool = False,
) -> dict:
    as_of = as_of or date.today()
    cutoff = as_of - timedelta(days=max(since_days, 1))
    state = _load_json(state_path)
    recommendations = _load_recommendations(recommendations_path)
    source_index_payload = _load_json(source_index_path)
    source_index = source_index_payload.get("papers", {})
    translations = _load_json(translations_path).get("translations", {})

    with catalog_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    papers = []
    for row in rows:
        published_at = _parse_date(row.get("published_date"))
        if not published_at or published_at < cutoff or published_at > as_of:
            continue
        if is_excluded_publication(_clean(row.get("title", "")), _clean(row.get("doi", ""))):
            continue
        paper = _paper_payload(row, published_at, recommendations, source_index, translations)
        if include_missing_abstracts or paper["abstract"]:
            papers.append(paper)

    papers.sort(key=lambda paper: (paper["addedAt"], paper["publishedAt"], paper["aiScore"]), reverse=True)
    generated_at = (
        source_index_payload.get("generatedAt")
        or state.get("completed_at")
        or datetime.now(timezone.utc).isoformat()
    )
    return {
        "generatedAt": generated_at,
        "window": {"from": cutoff.isoformat(), "to": as_of.isoformat(), "days": since_days},
        "source": {
            "catalog": catalog_path.name,
            "lastRunStatus": state.get("status", "unknown"),
            "lastRunNewCount": state.get("new_count", 0),
            "monitoredJournalCount": len({paper["journal"] for paper in papers}),
            "abstractCount": sum(1 for paper in papers if paper["abstract"]),
            "translationCount": sum(1 for paper in papers if paper["abstractKo"]),
        },
        "papers": papers,
    }


def _paper_payload(
    row: dict[str, str],
    published_at: date,
    recommendations: dict[str, dict],
    source_index: dict[str, dict],
    translations: dict[str, dict],
) -> dict:
    doi = _clean(row.get("doi", "")).lower()
    title = _clean(row.get("title", ""))
    stable_id = doi or hashlib.sha256(
        f"{row.get('journal', '')}|{published_at.isoformat()}|{title}".encode("utf-8")
    ).hexdigest()[:24]
    recommendation = recommendations.get(doi)
    source = source_index.get(stable_id, {})
    abstract_source = _clean(source.get("abstract", "")) or _clean(row.get("abstract", ""))
    abstract = strip_leading_abstract_label(abstract_source)
    translation = translations.get(stable_id, {})
    compatible_hashes = {
        hashlib.sha256(text.encode("utf-8")).hexdigest()
        for text in compatible_abstract_texts(abstract_source)
    }
    abstract_ko = (
        _clean(translation.get("textKo", ""))
        if translation.get("sourceHash") in compatible_hashes
        else ""
    )
    raw_score = _float(row.get("score"))
    matched_terms = _clean(row.get("matched_terms", ""))
    topics = _split(row.get("themes", ""))
    added_date = _parse_date(row.get("range_end")) or published_at

    return {
        "id": stable_id,
        "doi": doi,
        "url": _clean(row.get("url", "")) or (f"https://doi.org/{doi}" if doi else ""),
        "title": title,
        "authors": _authors(row.get("authors", "")),
        "journal": _clean(row.get("journal", "")),
        "journalShort": JOURNAL_SHORT_NAMES.get(_clean(row.get("journal", "")), _clean(row.get("journal", ""))),
        "publishedAt": published_at.isoformat(),
        "addedAt": f"{added_date.isoformat()}T00:00:00+09:00",
        "volume": _clean(row.get("volume", "")),
        "issue": _clean(row.get("issue", "")),
        "pages": _clean(row.get("pages", "")),
        "abstract": abstract,
        "abstractKo": abstract_ko,
        "abstractSourceUrl": _clean(
            source.get("abstractSourceUrl", "") or source.get("sourceUrl", "")
        ),
        "topics": topics,
        "aiScore": _display_score(raw_score),
        "relevanceRaw": raw_score,
        "aiReason": _reason(topics, matched_terms),
        "priority": _clean(row.get("priority", "")),
        "recommendedBy": recommendation,
        "seedReviewScore": None,
    }


def _display_score(raw_score: float) -> int:
    return round(min(99, max(30, 30 + raw_score * 2.7)))


def _reason(topics: list[str], matched_terms: str) -> str:
    terms = []
    for group in matched_terms.split("|"):
        _, separator, value = group.partition(":")
        terms.extend(_split(value if separator else group, delimiter=","))
    unique_terms = list(dict.fromkeys(terms))[:6]
    if unique_terms:
        return f"LMI 연구 키워드 {', '.join(unique_terms)}와 직접 연결됩니다."
    if topics:
        return f"{', '.join(topics)} 연구축과 관련된 후보입니다."
    return "LMI 연구 주제 기반 규칙으로 선별된 후보입니다."


def _load_recommendations(path: Path | None) -> dict[str, dict]:
    if not path or not path.exists():
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = csv.DictReader(handle)
        return {
            _clean(row.get("doi", "")).lower(): {
                "name": _clean(row.get("name", "")),
                "role": _clean(row.get("role", "")),
                "note": _clean(row.get("note", "")),
            }
            for row in rows
            if _clean(row.get("doi", ""))
        }


def _load_json(path: Path | None) -> dict:
    if not path or not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _parse_date(value: str | None) -> date | None:
    try:
        return date.fromisoformat((value or "").strip()[:10])
    except ValueError:
        return None


def _authors(value: str | None) -> list[str]:
    return [_clean(part) for part in (value or "").split(",") if _clean(part)]


def _split(value: str | None, delimiter: str = ";") -> list[str]:
    return [_clean(part) for part in (value or "").split(delimiter) if _clean(part)]


def _clean(value: str | None) -> str:
    return " ".join(html.unescape(TAG_RE.sub("", str(value or ""))).split())


def _float(value: str | None) -> float:
    try:
        return float(value or 0)
    except ValueError:
        return 0.0


if __name__ == "__main__":
    main()
