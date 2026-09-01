from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

from paper_agent.openai_batch import OpenAIBatchClient, parse_batch_output_line, write_jsonl


DEFAULT_PAPERS = Path("public/data/papers.json")
DEFAULT_TRANSLATIONS = Path("data/abstract_translations/ko.json")
DEFAULT_REGISTRY = Path("data/abstract_translations/batches.json")
DEFAULT_CACHE_DIR = Path(".cache/abstract-translations")
TERMINAL_BATCH_STATES = {"completed", "failed", "expired", "cancelled"}
TRANSLATION_SCHEMA = {
    "type": "object",
    "properties": {"translation_ko": {"type": "string"}},
    "required": ["translation_ko"],
    "additionalProperties": False,
}
SYSTEM_PROMPT = """You translate biomedical journal abstracts from English to Korean.
Translate the entire abstract faithfully without summarizing, omitting, or adding information.
Use formal Korean scientific prose. Preserve gene and protein names, cell markers, pathways,
drug names, abbreviations, symbols, statistical values, units, and established nomenclature.
When a technical term is clearer in English, keep the English term in parentheses after its
Korean translation. Return only the requested structured output."""


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return
    if args.command == "prepare":
        prepare_batch(args)
    elif args.command == "translate-direct":
        translate_direct(args)
    elif args.command == "normalize":
        normalize_existing_translations(args)
    elif args.command == "submit":
        submit_batch(args)
    elif args.command == "sync":
        sync_batches(args)
    elif args.command == "status":
        print_status(args)
    elif args.command == "inspect":
        inspect_batch(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Translate public paper abstracts into Korean.")
    parser.set_defaults(
        papers_file=DEFAULT_PAPERS,
        translations_file=DEFAULT_TRANSLATIONS,
        registry_file=DEFAULT_REGISTRY,
        cache_dir=DEFAULT_CACHE_DIR,
    )
    subparsers = parser.add_subparsers(dest="command")

    prepare = subparsers.add_parser("prepare", help="Build an OpenAI Batch input for untranslated abstracts.")
    add_common_paths(prepare)
    prepare.add_argument("--model", default=os.environ.get("OPENAI_TRANSLATION_MODEL", "gpt-5.4-mini"))
    prepare.add_argument("--limit", type=int, default=0, help="Maximum abstracts; 0 means all due abstracts.")
    prepare.add_argument("--output", type=Path, default=None)
    prepare.add_argument("--manifest", type=Path, default=None)

    direct = subparsers.add_parser(
        "translate-direct",
        help="Translate abstracts with concurrent Responses API requests.",
    )
    add_common_paths(direct)
    direct.add_argument("--model", default=os.environ.get("OPENAI_TRANSLATION_MODEL", "gpt-5.4-mini"))
    direct.add_argument("--limit", type=int, default=0, help="Maximum abstracts; 0 means all due abstracts.")
    direct.add_argument("--workers", type=int, default=8)
    direct.add_argument("--max-attempts", type=int, default=7)
    direct.add_argument("--checkpoint-every", type=int, default=10)

    normalize = subparsers.add_parser(
        "normalize",
        help="Remove echoed title and journal metadata from stored translations.",
    )
    add_common_paths(normalize)

    submit = subparsers.add_parser("submit", help="Upload a prepared translation batch.")
    add_common_paths(submit)
    submit.add_argument("--input", type=Path, required=True)
    submit.add_argument("--manifest", type=Path, required=True)

    sync = subparsers.add_parser("sync", help="Import completed translation batches.")
    add_common_paths(sync)
    sync.add_argument("--wait-seconds", type=int, default=0)
    sync.add_argument("--poll-seconds", type=int, default=60)

    status = subparsers.add_parser("status", help="Show translation progress.")
    add_common_paths(status)

    inspect = subparsers.add_parser("inspect", help="Print a Batch status and validation errors.")
    inspect.add_argument("--batch-id", required=True)
    return parser


def add_common_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--papers-file", type=Path, default=DEFAULT_PAPERS)
    parser.add_argument("--translations-file", type=Path, default=DEFAULT_TRANSLATIONS)
    parser.add_argument("--registry-file", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)


def prepare_batch(args: argparse.Namespace) -> None:
    papers = load_papers(args.papers_file)
    translations = load_json(args.translations_file, default_translations())
    registry = load_json(args.registry_file, default_registry())
    output = args.output or args.cache_dir / "abstract-translations.jsonl"
    manifest_path = args.manifest or args.cache_dir / "abstract-translations.manifest.json"
    due = due_papers(papers, translations, registry)
    if args.limit > 0:
        due = due[: args.limit]

    rows = []
    items = []
    for paper in due:
        abstract = str(paper.get("abstract") or "").strip()
        digest = source_hash(abstract)
        custom_id = "abstract-ko-" + hashlib.sha256(
            f"{paper['id']}|{digest}".encode("utf-8")
        ).hexdigest()[:24]
        rows.append(make_translation_request(custom_id, paper, args.model))
        items.append(
            {
                "customId": custom_id,
                "paperId": paper["id"],
                "sourceHash": digest,
                "title": paper.get("title", ""),
            }
        )

    write_jsonl(output, rows)
    write_json(
        manifest_path,
        {
            "schemaVersion": 1,
            "createdAt": utc_now(),
            "model": args.model,
            "items": items,
        },
    )
    print(f"Translation requests prepared: {len(items)}")
    print(f"Batch input: {output}")
    print(f"Manifest: {manifest_path}")


def submit_batch(args: argparse.Namespace) -> None:
    manifest = load_json(args.manifest, {})
    items = manifest.get("items", [])
    if not items or not args.input.exists() or args.input.stat().st_size == 0:
        print("No translation requests to submit.")
        return

    client = OpenAIBatchClient(os.environ.get("OPENAI_API_KEY", ""))
    uploaded = client.upload_batch_file(args.input)
    client.wait_for_file_ready(uploaded["id"])
    batch = client.create_batch(
        uploaded["id"],
        metadata={"job": "lmi-abstract-ko", "model": str(manifest.get("model", ""))},
    )
    registry = load_json(args.registry_file, default_registry())
    registry.setdefault("jobs", []).append(
        {
            "batchId": batch["id"],
            "inputFileId": uploaded["id"],
            "inputPath": args.input.as_posix(),
            "manifestPath": args.manifest.as_posix(),
            "model": manifest.get("model", "gpt-5.4-mini"),
            "items": items,
            "status": batch.get("status", "validating"),
            "submittedAt": utc_now(),
            "checkedAt": utc_now(),
            "outputFileId": "",
            "errorFileId": "",
            "requestScope": client.request_scope,
        }
    )
    write_json(args.registry_file, registry)
    print(f"Translation batch submitted: {batch['id']}")
    print(f"Abstracts in batch: {len(items)}")
    print(f"OpenAI request scope: {json.dumps(client.request_scope, ensure_ascii=False)}")


def translate_direct(args: argparse.Namespace) -> None:
    papers = load_papers(args.papers_file)
    translations = load_json(args.translations_file, default_translations())
    registry = load_json(args.registry_file, default_registry())
    due = due_papers(papers, translations, registry)
    if args.limit > 0:
        due = due[: args.limit]
    if not due:
        print("No abstracts need Korean translation.")
        return

    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise ValueError("OPENAI_API_KEY is required")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if os.environ.get("OPENAI_ORGANIZATION"):
        headers["OpenAI-Organization"] = os.environ["OPENAI_ORGANIZATION"]
    if os.environ.get("OPENAI_PROJECT"):
        headers["OpenAI-Project"] = os.environ["OPENAI_PROJECT"]

    records = translations.setdefault("translations", {})
    completed = 0
    failures: list[tuple[str, str]] = []
    workers = max(1, min(args.workers, 32))
    print(f"Direct translations queued: {len(due)} (workers: {workers})", flush=True)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                request_direct_translation,
                paper,
                args.model,
                headers,
                args.max_attempts,
            ): paper
            for paper in due
        }
        for future in as_completed(futures):
            paper = futures[future]
            try:
                translated = future.result()
            except Exception as exc:  # Continue so successful translations can be published.
                failures.append((paper["id"], str(exc)))
                print(f"Translation failed [{paper['id']}]: {exc}", flush=True)
                continue
            records[paper["id"]] = {
                "sourceHash": source_hash(paper["abstract"]),
                "textKo": translated,
                "model": args.model,
                "translatedAt": utc_now(),
            }
            completed += 1
            if completed % max(args.checkpoint_every, 1) == 0:
                translations["generatedAt"] = utc_now()
                write_json(args.translations_file, translations)
                print(f"Translation checkpoint: {completed}/{len(due)}", flush=True)

    translations["generatedAt"] = utc_now()
    write_json(args.translations_file, translations)
    print(f"Direct translations completed: {completed}/{len(due)}")
    print(f"Direct translation failures: {len(failures)}")


def normalize_existing_translations(args: argparse.Namespace) -> None:
    translations = load_json(args.translations_file, default_translations())
    changed = 0
    for record in translations.get("translations", {}).values():
        original = str(record.get("textKo") or "")
        normalized = normalize_translation(original)
        if normalized != original:
            record["textKo"] = normalized
            changed += 1
    if changed:
        translations["generatedAt"] = utc_now()
        write_json(args.translations_file, translations)
    print(f"Normalized translation metadata prefixes: {changed}")


def request_direct_translation(
    paper: dict,
    model: str,
    headers: dict[str, str],
    max_attempts: int,
) -> str:
    body = make_translation_request("direct", paper, model)["body"]
    last_error = "unknown error"
    for attempt in range(max(1, max_attempts)):
        try:
            response = requests.post(
                "https://api.openai.com/v1/responses",
                headers=headers,
                json=body,
                timeout=180,
            )
            if response.status_code == 429 or response.status_code >= 500:
                retry_after = response.headers.get("retry-after")
                delay = float(retry_after) if retry_after else min(2**attempt, 60) + random.random()
                last_error = f"HTTP {response.status_code}: {response.text[:300]}"
                time.sleep(delay)
                continue
            response.raise_for_status()
            translated = parse_direct_translation(response.json())
            if not translated:
                raise ValueError("response did not contain translation_ko")
            return normalize_translation(translated)
        except (requests.RequestException, ValueError, json.JSONDecodeError) as exc:
            last_error = str(exc)
            if attempt + 1 < max(1, max_attempts):
                time.sleep(min(2**attempt, 60) + random.random())
    raise RuntimeError(last_error)


def parse_direct_translation(response_body: dict) -> str:
    envelope = json.dumps(
        {"custom_id": "direct", "response": {"status_code": 200, "body": response_body}},
        ensure_ascii=False,
    )
    _, payload, error = parse_batch_output_line(envelope)
    if error:
        raise ValueError(error)
    return str((payload or {}).get("translation_ko") or "").strip()


def normalize_translation(text: str) -> str:
    normalized = str(text or "").strip()
    starts_with_title = bool(re.match(r"^(?:제목|표제|TITLE)\s*[:：]", normalized, re.IGNORECASE))
    abstract_marker = re.search(r"(?:초록|ABSTRACT)\s*[:：]\s*", normalized, re.IGNORECASE)
    if abstract_marker and abstract_marker.start() <= 1000:
        prefix = normalized[: abstract_marker.start()]
        has_journal_marker = bool(
            re.search(r"(?:저널|학술지|JOURNAL)\s*[:：]", prefix, re.IGNORECASE)
        )
        if starts_with_title or has_journal_marker:
            return normalized[abstract_marker.end() :].strip()

    if starts_with_title:
        separator = re.search(r"\s{2,}", normalized)
        if separator and separator.start() <= 1000:
            return normalized[separator.end() :].strip()
    return normalized


def sync_batches(args: argparse.Namespace) -> None:
    client = OpenAIBatchClient(os.environ.get("OPENAI_API_KEY", ""))
    deadline = time.monotonic() + max(args.wait_seconds, 0)
    while True:
        registry = load_json(args.registry_file, default_registry())
        translations = load_json(args.translations_file, default_translations())
        active = [job for job in registry.get("jobs", []) if job.get("status") not in TERMINAL_BATCH_STATES]
        if not active:
            write_json(args.registry_file, registry)
            write_json(args.translations_file, translations)
            print("No active translation batches.")
            return

        for job in active:
            batch = client.retrieve_batch(job["batchId"])
            job["status"] = batch.get("status", job.get("status", "unknown"))
            job["checkedAt"] = utc_now()
            job["outputFileId"] = batch.get("output_file_id") or ""
            job["errorFileId"] = batch.get("error_file_id") or ""
            job["requestCounts"] = batch.get("request_counts") or {}
            job["batchErrors"] = (batch.get("errors") or {}).get("data", [])
            print(f"Translation batch {job['batchId']}: {job['status']}", flush=True)
            if job["status"] == "completed" and job["outputFileId"] and not job.get("importedAt"):
                output_text = client.download_file(job["outputFileId"])
                imported, errors = apply_batch_output(output_text, job, translations)
                job["importedAt"] = utc_now()
                job["importedCount"] = imported
                job["errorCount"] = errors
                print(f"Imported {imported} translations from {job['batchId']} ({errors} errors).")

        translations["generatedAt"] = utc_now()
        registry["updatedAt"] = utc_now()
        write_json(args.translations_file, translations)
        write_json(args.registry_file, registry)

        remaining = [job for job in registry.get("jobs", []) if job.get("status") not in TERMINAL_BATCH_STATES]
        if not remaining or time.monotonic() >= deadline:
            print(f"Active translation batches remaining: {len(remaining)}")
            return
        time.sleep(max(args.poll_seconds, 5))


def print_status(args: argparse.Namespace) -> None:
    papers = load_papers(args.papers_file)
    translations = load_json(args.translations_file, default_translations())
    registry = load_json(args.registry_file, default_registry())
    translated = sum(
        1
        for paper in papers
        if valid_translation(translations.get("translations", {}).get(paper.get("id"), {}), paper.get("abstract", ""))
    )
    active = sum(1 for job in registry.get("jobs", []) if job.get("status") not in TERMINAL_BATCH_STATES)
    print(f"Public abstracts: {len(papers)}")
    print(f"Current Korean translations: {translated}")
    print(f"Translations due: {len(papers) - translated}")
    print(f"Active batches: {active}")


def inspect_batch(args: argparse.Namespace) -> None:
    client = OpenAIBatchClient(os.environ.get("OPENAI_API_KEY", ""))
    batch = client.retrieve_batch(args.batch_id)
    summary = {
        "id": batch.get("id", ""),
        "status": batch.get("status", "unknown"),
        "errors": (batch.get("errors") or {}).get("data", []),
        "request_counts": batch.get("request_counts") or {},
        "output_file_id": batch.get("output_file_id") or "",
        "error_file_id": batch.get("error_file_id") or "",
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def make_translation_request(custom_id: str, paper: dict, model: str) -> dict:
    prompt = (
        f"TITLE: {paper.get('title', '')}\n"
        f"JOURNAL: {paper.get('journal', '')}\n"
        f"ABSTRACT:\n{paper.get('abstract', '')}"
    )
    return {
        "custom_id": custom_id,
        "method": "POST",
        "url": "/v1/responses",
        "body": {
            "model": model,
            "reasoning": {"effort": "none"},
            "max_output_tokens": 5000,
            "input": [
                {"role": "system", "content": [{"type": "input_text", "text": SYSTEM_PROMPT}]},
                {"role": "user", "content": [{"type": "input_text", "text": prompt}]},
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "abstract_translation_ko",
                    "strict": True,
                    "schema": TRANSLATION_SCHEMA,
                }
            },
        },
    }


def apply_batch_output(output_text: str, job: dict, translations: dict) -> tuple[int, int]:
    item_by_custom_id = {item["customId"]: item for item in job.get("items", [])}
    records = translations.setdefault("translations", {})
    imported = 0
    errors = 0
    for line in output_text.splitlines():
        if not line.strip():
            continue
        custom_id, payload, error = parse_batch_output_line(line)
        item = item_by_custom_id.get(custom_id)
        translated = str((payload or {}).get("translation_ko") or "").strip()
        if error or not item or not translated:
            errors += 1
            continue
        records[item["paperId"]] = {
            "sourceHash": item["sourceHash"],
            "textKo": translated,
            "model": job.get("model", ""),
            "translatedAt": utc_now(),
        }
        imported += 1
    return imported, errors


def due_papers(papers: list[dict], translations: dict, registry: dict) -> list[dict]:
    active_ids = {
        item["paperId"]
        for job in registry.get("jobs", [])
        if job.get("status") not in TERMINAL_BATCH_STATES
        for item in job.get("items", [])
    }
    records = translations.get("translations", {})
    return [
        paper
        for paper in papers
        if paper.get("id")
        and str(paper.get("abstract") or "").strip()
        and paper["id"] not in active_ids
        and not valid_translation(records.get(paper["id"], {}), paper["abstract"])
    ]


def valid_translation(record: dict, abstract: str) -> bool:
    return bool(record.get("textKo")) and record.get("sourceHash") == source_hash(abstract)


def source_hash(abstract: str) -> str:
    normalized = " ".join(str(abstract or "").split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def load_papers(path: Path) -> list[dict]:
    payload = load_json(path, {"papers": []})
    return list(payload.get("papers", []))


def load_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return json.loads(json.dumps(default))
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def default_translations() -> dict:
    return {"schemaVersion": 1, "generatedAt": "", "translations": {}}


def default_registry() -> dict:
    return {"schemaVersion": 1, "updatedAt": "", "jobs": []}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
