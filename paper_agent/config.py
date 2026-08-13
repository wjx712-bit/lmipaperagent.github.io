from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from paper_agent.models import Journal


def load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"Missing config file: {path}")
    with path.open("r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Expected mapping in {path}")
    return data


def load_lab_profile(config_dir: Path, filename: str = "lab_profile.yml") -> dict[str, Any]:
    return load_yaml(config_dir / filename)


def load_journals(config_dir: Path, filename: str = "journals.yml") -> list[Journal]:
    raw = load_yaml(config_dir / filename)
    journals = []
    for item in raw.get("journals", []):
        journals.append(
            Journal(
                name=item["name"],
                tier=item["tier"],
                priority_weight=int(item.get("priority_weight", 0)),
                query_titles=list(item.get("query_titles") or [item["name"]]),
                aliases=list(item.get("aliases") or []),
                issns=list(item.get("issns") or []),
                start_year=int(item["start_year"]) if item.get("start_year") else None,
                active=bool(item.get("active", True)),
                needs_confirmation=bool(item.get("needs_confirmation", False)),
                note=str(item.get("note", "")),
            )
        )
    return [journal for journal in journals if journal.active]


def load_optional_yaml(config_dir: Path, filename: str) -> dict[str, Any]:
    path = config_dir / filename
    if not path.exists():
        return {}
    return load_yaml(path)
