from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Iterable

import requests

from paper_agent.analysis_schema import ANALYSIS_SYSTEM_PROMPT, PAPER_ANALYSIS_SCHEMA
from paper_agent.europe_pmc import article_text, figure_text


OPENAI_API_BASE = "https://api.openai.com/v1"


class OpenAIBatchClient:
    def __init__(
        self,
        api_key: str,
        timeout: float = 90,
        organization: str | None = None,
        project: str | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("OPENAI_API_KEY is required")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {api_key}"})
        organization = organization or os.environ.get("OPENAI_ORGANIZATION")
        project = project or os.environ.get("OPENAI_PROJECT")
        self.request_scope: dict[str, str] = {}
        if organization:
            self.session.headers["OpenAI-Organization"] = organization
            self.request_scope["organization"] = organization
        if project:
            self.session.headers["OpenAI-Project"] = project
            self.request_scope["project"] = project

    def _pin_response_scope(self, response: requests.Response) -> None:
        response_headers = {
            "organization": response.headers.get("openai-organization"),
            "project": response.headers.get("openai-project"),
        }
        request_headers = {
            "organization": "OpenAI-Organization",
            "project": "OpenAI-Project",
        }
        for name, value in response_headers.items():
            if not value:
                continue
            if name == "organization" and not value.startswith("org-"):
                continue
            header = request_headers[name]
            existing = self.session.headers.get(header)
            if existing and existing != value:
                raise RuntimeError(
                    f"OpenAI request scope changed for {name}: {existing} -> {value}"
                )
            self.session.headers[header] = value
            self.request_scope[name] = value

    def upload_batch_file(self, path: Path) -> dict:
        with path.open("rb") as handle:
            response = self.session.post(
                f"{OPENAI_API_BASE}/files",
                data={"purpose": "batch"},
                files={"file": (path.name, handle, "application/jsonl")},
                timeout=self.timeout,
            )
        response.raise_for_status()
        self._pin_response_scope(response)
        return response.json()

    def retrieve_file(self, file_id: str) -> dict:
        response = self.session.get(f"{OPENAI_API_BASE}/files/{file_id}", timeout=self.timeout)
        response.raise_for_status()
        self._pin_response_scope(response)
        return response.json()

    def wait_for_file_ready(
        self,
        file_id: str,
        timeout_seconds: float = 300,
        poll_seconds: float = 2,
        settle_seconds: float = 5,
    ) -> dict:
        deadline = time.monotonic() + max(timeout_seconds, 0)
        while True:
            file = self.retrieve_file(file_id)
            status = file.get("status")
            purpose = file.get("purpose")
            if purpose and purpose != "batch":
                raise RuntimeError(f"OpenAI file {file_id} has unexpected purpose: {purpose}")
            if status == "error":
                details = file.get("status_details") or "unknown file processing error"
                raise RuntimeError(f"OpenAI file {file_id} could not be processed: {details}")
            # File status is deprecated in newer API responses. A successful retrieval
            # without it means the file is available; older responses use `processed`.
            if status in {None, "processed"}:
                if settle_seconds > 0:
                    time.sleep(settle_seconds)
                return file
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"OpenAI file {file_id} was not ready after {timeout_seconds:g} seconds "
                    f"(last status: {status or 'unknown'})"
                )
            time.sleep(max(poll_seconds, 0.1))

    def create_batch(self, input_file_id: str, metadata: dict[str, str] | None = None) -> dict:
        response = self.session.post(
            f"{OPENAI_API_BASE}/batches",
            headers={"Content-Type": "application/json"},
            json={
                "input_file_id": input_file_id,
                "endpoint": "/v1/responses",
                "completion_window": "24h",
                "metadata": metadata or {},
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        self._pin_response_scope(response)
        return response.json()

    def retrieve_batch(self, batch_id: str) -> dict:
        response = self.session.get(f"{OPENAI_API_BASE}/batches/{batch_id}", timeout=self.timeout)
        response.raise_for_status()
        self._pin_response_scope(response)
        return response.json()

    def download_file(self, file_id: str) -> str:
        response = self.session.get(f"{OPENAI_API_BASE}/files/{file_id}/content", timeout=self.timeout)
        response.raise_for_status()
        self._pin_response_scope(response)
        return response.text


def make_batch_request(
    custom_id: str,
    paper: dict,
    source: dict,
    model: str,
    include_figure_images: bool = True,
    max_figure_images: int = 12,
) -> dict:
    level = source["evidence_level"]
    article = source.get("article") or {}
    if level == "full_text":
        material = article_text(article)
        captions = figure_text(article)
    else:
        material = source.get("abstract", "")
        captions = ""

    metadata = {
        "title": paper.get("title", ""),
        "authors": paper.get("authors", []),
        "journal": paper.get("journal", ""),
        "published_at": paper.get("publishedAt", ""),
        "doi": paper.get("doi", ""),
        "original_url": paper.get("url", ""),
    }
    prompt = (
        f"SOURCE_LEVEL: {level}\n"
        f"PAPER_METADATA:\n{json.dumps(metadata, ensure_ascii=False)}\n\n"
        f"ARTICLE_MATERIAL:\n{material}\n\n"
        f"MAIN_FIGURE_CAPTIONS:\n{captions or 'Not available from this source.'}"
    )
    user_content: list[dict] = [{"type": "input_text", "text": prompt}]
    if level == "full_text" and include_figure_images:
        figures = [figure for figure in article.get("figures", []) if figure.get("image_data_url")]
        for figure in figures[:max_figure_images]:
            user_content.append(
                {
                    "type": "input_text",
                    "text": f"IMAGE FOR {figure['label']}:",
                }
            )
            user_content.append(
                {
                    "type": "input_image",
                    "image_url": figure["image_data_url"],
                    "detail": "high",
                }
            )

    return {
        "custom_id": custom_id,
        "method": "POST",
        "url": "/v1/responses",
        "body": {
            "model": model,
            "reasoning": {"effort": "medium"},
            "max_output_tokens": 14000,
            "input": [
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": ANALYSIS_SYSTEM_PROMPT}],
                },
                {"role": "user", "content": user_content},
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "paper_analysis",
                    "strict": True,
                    "schema": PAPER_ANALYSIS_SCHEMA,
                }
            },
        },
    }


def write_jsonl(path: Path, rows: Iterable[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            count += 1
    return count


def parse_batch_output_line(line: str) -> tuple[str, dict | None, str | None]:
    envelope = json.loads(line)
    custom_id = envelope.get("custom_id", "")
    error = envelope.get("error")
    response = envelope.get("response") or {}
    if error:
        return custom_id, None, json.dumps(error, ensure_ascii=False)
    if response.get("status_code") != 200:
        return custom_id, None, json.dumps(response.get("body", response), ensure_ascii=False)

    body = response.get("body") or {}
    for output in body.get("output", []):
        if output.get("type") != "message":
            continue
        for content in output.get("content", []):
            if content.get("type") == "output_text" and content.get("text"):
                try:
                    return custom_id, json.loads(content["text"]), None
                except json.JSONDecodeError as exc:
                    return custom_id, None, f"invalid JSON output: {exc}"
    return custom_id, None, "response did not contain output_text"
