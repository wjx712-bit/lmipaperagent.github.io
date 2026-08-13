from __future__ import annotations

from typing import Any


SCHEMA_VERSION = 1


PAPER_ANALYSIS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "evidence_level": {
            "type": "string",
            "enum": ["full_text", "abstract"],
        },
        "research_background": {"type": "string"},
        "main_question": {"type": "string"},
        "hypothesis": {"type": "string"},
        "experimental_models": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "model": {"type": "string"},
                    "details": {"type": "string"},
                },
                "required": ["model", "details"],
            },
        },
        "methods": {"type": "array", "items": {"type": "string"}},
        "key_results": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "finding": {"type": "string"},
                    "evidence": {"type": "string"},
                    "figures": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["finding", "evidence", "figures"],
            },
        },
        "summary": {"type": "string"},
        "conclusion": {"type": "string"},
        "limitations": {"type": "array", "items": {"type": "string"}},
        "figure_by_figure_analysis": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "figure": {"type": "string"},
                    "question": {"type": "string"},
                    "approach": {"type": "string"},
                    "result": {"type": "string"},
                    "interpretation": {"type": "string"},
                    "confidence": {
                        "type": "string",
                        "enum": ["high", "medium", "low"],
                    },
                },
                "required": [
                    "figure",
                    "question",
                    "approach",
                    "result",
                    "interpretation",
                    "confidence",
                ],
            },
        },
        "source_caveats": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "evidence_level",
        "research_background",
        "main_question",
        "hypothesis",
        "experimental_models",
        "methods",
        "key_results",
        "summary",
        "conclusion",
        "limitations",
        "figure_by_figure_analysis",
        "source_caveats",
    ],
}


ANALYSIS_SYSTEM_PROMPT = """You are a senior biomedical research analyst for a metabolism and immunology laboratory.
Analyze only the supplied article material. Never invent experiments, numerical results, mechanisms, figures, or limitations.
Write the analysis in clear Korean while preserving standard English technical terms, gene names, assay names, and model names.

Evidence rules:
- If SOURCE_LEVEL is full_text, use the article body and figure captions as evidence.
- If SOURCE_LEVEL is abstract, keep every field conservative, list only information explicitly present in the abstract, and leave figure_by_figure_analysis empty.
- When a hypothesis is not explicitly stated, say that it is not explicitly stated and identify only the directly supported research premise.
- Separate author-stated limitations from analyst-inferred limitations. Prefix inferred items with '[분석자 추론]'.
- Each key result must cite the supporting figure label when the supplied text makes that connection. Otherwise use an empty figures array.
- Analyze each supplied main figure exactly once. Do not create entries for figures not present in the source.
- A figure caption alone can support a cautious description, but not an unreported causal interpretation.
- Keep the overall summary concise enough for weekly lab screening, while retaining concrete experimental detail.
"""


def validate_analysis(payload: dict[str, Any]) -> list[str]:
    """Return lightweight validation errors for imported model output."""
    errors: list[str] = []
    required = PAPER_ANALYSIS_SCHEMA["required"]
    for field in required:
        if field not in payload:
            errors.append(f"missing field: {field}")

    if payload.get("evidence_level") not in {"full_text", "abstract"}:
        errors.append("invalid evidence_level")

    list_fields = {
        "experimental_models",
        "methods",
        "key_results",
        "limitations",
        "figure_by_figure_analysis",
        "source_caveats",
    }
    for field in list_fields:
        if field in payload and not isinstance(payload[field], list):
            errors.append(f"{field} must be a list")

    text_fields = {
        "research_background",
        "main_question",
        "hypothesis",
        "summary",
        "conclusion",
    }
    for field in text_fields:
        if field in payload and not isinstance(payload[field], str):
            errors.append(f"{field} must be a string")

    if payload.get("evidence_level") == "abstract" and payload.get("figure_by_figure_analysis"):
        errors.append("abstract-only analysis must not include figure analysis")
    return errors
