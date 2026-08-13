from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from paper_agent.analysis_schema import SCHEMA_VERSION, validate_analysis
from paper_agent.europe_pmc import EuropePmcClient, extract_article, normalize_doi
from paper_agent.openai_batch import (
    OpenAIBatchClient,
    make_batch_request,
    parse_batch_output_line,
    write_jsonl,
)


DEFAULT_PAPERS = Path("public/data/papers.json")
DEFAULT_SOURCE_INDEX = Path("data/paper_analysis/source_index.json")
DEFAULT_BATCH_REGISTRY = Path("data/paper_analysis/batches.json")
DEFAULT_PUBLIC_INDEX = Path("public/data/analysis-index.json")
DEFAULT_ANALYSIS_DIR = Path("public/data/analysis")
DEFAULT_CACHE_DIR = Path(".cache/paper-analysis")
TERMINAL_BATCH_STATES = {"completed", "failed", "expired", "cancelled"}


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return
    try:
        if args.command == "discover":
            discover_sources(args)
        elif args.command == "build-batch":
            build_batch(args)
        elif args.command == "submit-batch":
            submit_batch(args)
        elif args.command == "sync-batches":
            sync_batches(args)
        elif args.command == "export-index":
            export_public_index(args)
        elif args.command == "status":
            print_status(args)
        elif args.command == "run-cycle":
            run_cycle(args)
    except KeyboardInterrupt:
        print("Interrupted; completed records are already saved.", file=sys.stderr)
        raise SystemExit(130)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Discover legal article sources and build structured paper-analysis batches."
    )
    parser.set_defaults(
        papers_file=DEFAULT_PAPERS,
        source_index=DEFAULT_SOURCE_INDEX,
        cache_dir=DEFAULT_CACHE_DIR,
        analysis_dir=DEFAULT_ANALYSIS_DIR,
        public_index=DEFAULT_PUBLIC_INDEX,
        batch_registry=DEFAULT_BATCH_REGISTRY,
    )
    subparsers = parser.add_subparsers(dest="command")

    discover = subparsers.add_parser("discover", help="Discover abstracts and open full text in Europe PMC.")
    add_common_paths(discover)
    discover.add_argument("--limit", type=int, default=0, help="Maximum papers to query; 0 means all due papers.")
    discover.add_argument("--batch-size", type=int, default=20)
    discover.add_argument("--retry-days", type=int, default=14)
    discover.add_argument("--refresh", action="store_true")
    discover.add_argument("--pause-seconds", type=float, default=0.1)

    build = subparsers.add_parser("build-batch", help="Fetch source material and create an OpenAI Batch JSONL file.")
    add_common_paths(build)
    build.add_argument("--limit", type=int, default=10)
    build.add_argument("--model", default=os.environ.get("OPENAI_ANALYSIS_MODEL", "gpt-5.6-terra"))
    build.add_argument("--evidence-level", choices=["all", "full_text", "abstract"], default="all")
    build.add_argument("--no-figure-images", action="store_true")
    build.add_argument("--max-figure-images", type=int, default=12)
    build.add_argument("--max-figure-bytes", type=int, default=6_000_000)
    build.add_argument("--force", action="store_true")

    submit = subparsers.add_parser("submit-batch", help="Upload a prepared JSONL file and start an OpenAI Batch job.")
    add_common_paths(submit)
    submit.add_argument("--input", type=Path, required=True)

    sync = subparsers.add_parser("sync-batches", help="Poll submitted batches and import completed analyses.")
    add_common_paths(sync)

    export = subparsers.add_parser("export-index", help="Publish analysis availability for the website.")
    add_common_paths(export)

    status = subparsers.add_parser("status", help="Print source and analysis progress.")
    add_common_paths(status)

    cycle = subparsers.add_parser("run-cycle", help="Discover, sync, and submit resumable analysis batches.")
    add_common_paths(cycle)
    cycle.add_argument("--batch-count", type=int, default=2)
    cycle.add_argument("--papers-per-batch", type=int, default=20)
    cycle.add_argument("--max-active-batches", type=int, default=8)
    cycle.add_argument("--batch-size", type=int, default=20)
    cycle.add_argument("--retry-days", type=int, default=14)
    cycle.add_argument("--pause-seconds", type=float, default=0.1)
    cycle.add_argument("--model", default=os.environ.get("OPENAI_ANALYSIS_MODEL", "gpt-5.6-terra"))
    cycle.add_argument("--evidence-level", choices=["all", "full_text", "abstract"], default="all")
    cycle.add_argument("--no-figure-images", action="store_true")
    cycle.add_argument("--max-figure-images", type=int, default=12)
    cycle.add_argument("--max-figure-bytes", type=int, default=6_000_000)
    return parser


def add_common_paths(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--papers-file", type=Path, default=DEFAULT_PAPERS)
    parser.add_argument("--source-index", type=Path, default=DEFAULT_SOURCE_INDEX)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument("--analysis-dir", type=Path, default=DEFAULT_ANALYSIS_DIR)
    parser.add_argument("--public-index", type=Path, default=DEFAULT_PUBLIC_INDEX)
    parser.add_argument("--batch-registry", type=Path, default=DEFAULT_BATCH_REGISTRY)


def discover_sources(args: argparse.Namespace) -> None:
    papers = load_papers(args.papers_file)
    index = load_json(args.source_index, default_source_index())
    now = utc_now()
    retry_before = datetime.now(timezone.utc) - timedelta(days=max(args.retry_days, 0))
    due: list[dict] = []
    for paper in papers:
        doi = normalize_doi(paper.get("doi"))
        if not doi:
            continue
        existing = index["papers"].get(paper["id"])
        if args.refresh or not existing or is_retry_due(existing, retry_before):
            due.append(paper)
    if args.limit > 0:
        due = due[: args.limit]
    if not due:
        print("No paper sources are due for discovery.")
        export_public_index(args)
        return

    client = EuropePmcClient(pause_seconds=args.pause_seconds)
    chunk_size = max(1, args.batch_size)
    for offset in range(0, len(due), chunk_size):
        chunk = due[offset : offset + chunk_size]
        records = client.discover_many((paper.get("doi", "") for paper in chunk), batch_size=chunk_size)
        for paper in chunk:
            doi = normalize_doi(paper.get("doi"))
            record = records.get(doi)
            if record:
                cache = record.to_dict()
                write_json(source_cache_path(args.cache_dir, paper["id"]), cache)
                index["papers"][paper["id"]] = {
                    "doi": doi,
                    "status": "source_ready" if record.evidence_level else "source_unavailable",
                    "evidenceLevel": record.evidence_level,
                    "provider": "Europe PMC",
                    "pmid": record.pmid,
                    "pmcid": record.pmcid,
                    "sourceUrl": record.source_url,
                    "abstractCharacters": len(record.abstract),
                    "figureCount": None,
                    "checkedAt": now,
                    "lastError": "",
                }
            else:
                index["papers"][paper["id"]] = {
                    "doi": doi,
                    "status": "not_found",
                    "evidenceLevel": None,
                    "provider": "Europe PMC",
                    "pmid": "",
                    "pmcid": "",
                    "sourceUrl": "",
                    "abstractCharacters": 0,
                    "figureCount": None,
                    "checkedAt": now,
                    "lastError": "",
                }
        index["generatedAt"] = utc_now()
        write_json(args.source_index, index)
        done = min(offset + len(chunk), len(due))
        print(f"Source discovery: {done}/{len(due)}")
    export_public_index(args)


def build_batch(args: argparse.Namespace) -> None:
    papers = load_papers(args.papers_file)
    source_index = load_json(args.source_index, default_source_index())
    selected: list[tuple[dict, dict]] = []
    client = EuropePmcClient(pause_seconds=0)

    for paper in papers:
        source_meta = source_index["papers"].get(paper["id"], {})
        if source_meta.get("status") != "source_ready" or not source_meta.get("evidenceLevel"):
            continue
        if args.evidence_level != "all" and source_meta.get("evidenceLevel") != args.evidence_level:
            continue
        if not args.force and analysis_output_path(args.analysis_dir, paper["id"]).exists():
            continue
        prepared_path = Path(source_meta.get("preparedInputPath", ""))
        has_local_prepared_batch = (
            source_meta.get("analysisStatus") == "prepared"
            and source_meta.get("preparedInputPath")
            and prepared_path.exists()
        )
        if (source_meta.get("analysisStatus") == "submitted" or has_local_prepared_batch) and not args.force:
            continue
        try:
            source = prepare_source(paper, source_meta, args.cache_dir, client)
        except Exception as exc:  # Keep the queue moving when one publisher record is malformed.
            source_meta["lastError"] = str(exc)[:500]
            source_meta["checkedAt"] = utc_now()
            print(f"Source preparation failed for {paper['id']}: {exc}", file=sys.stderr)
            continue
        if source["evidence_level"] == "full_text" and not args.no_figure_images:
            try:
                figures = (source.get("article") or {}).get("figures", [])[: max(0, args.max_figure_images)]
                image_data = client.fetch_figure_data_urls(
                    source.get("pmcid") or source_meta.get("pmcid"),
                    (figure.get("asset", "") for figure in figures),
                    package_cache_path=(
                        args.cache_dir
                        / "oa_packages"
                        / f"{source.get('pmcid') or source_meta.get('pmcid')}.tar.gz"
                    ),
                    max_total_bytes=max(0, args.max_figure_bytes),
                )
                for figure in figures:
                    figure["image_data_url"] = image_data.get(figure.get("asset", ""), "")
                source_meta["figureImageCount"] = len(image_data)
                source_meta["figureImageError"] = ""
            except Exception as exc:
                source_meta["figureImageCount"] = 0
                source_meta["figureImageError"] = str(exc)[:500]
                print(f"Figure images unavailable for {paper['id']}; captions retained: {exc}", file=sys.stderr)
        source_meta["evidenceLevel"] = source["evidence_level"]
        source_meta["figureCount"] = len((source.get("article") or {}).get("figures", []))
        source_meta["lastError"] = ""
        selected.append((paper, source))
        if len(selected) >= max(1, args.limit):
            break

    if not selected:
        source_index["generatedAt"] = utc_now()
        write_json(args.source_index, source_index)
        export_public_index(args)
        print("No source-ready papers are waiting for a batch.")
        return None

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    input_path = args.cache_dir / "batch_inputs" / f"paper-analysis-{stamp}.jsonl"
    manifest_path = input_path.with_suffix(".manifest.json")
    requests = []
    manifest_items = []
    for paper, source in selected:
        custom_id = f"paper-{analysis_key(paper['id'])}"
        requests.append(
            make_batch_request(
                custom_id=custom_id,
                paper=paper,
                source=source,
                model=args.model,
                include_figure_images=not args.no_figure_images,
                max_figure_images=max(0, args.max_figure_images),
            )
        )
        manifest_items.append(
            {
                "customId": custom_id,
                "paperId": paper["id"],
                "doi": paper.get("doi", ""),
                "title": paper.get("title", ""),
                "originalUrl": paper.get("url", ""),
                "evidenceLevel": source["evidence_level"],
                "sourceUrl": source.get("source_url", ""),
                "pmcid": source.get("pmcid", ""),
                "figureLabels": [
                    figure.get("label", "")
                    for figure in (source.get("article") or {}).get("figures", [])
                ],
                "analysisPath": analysis_output_path(args.analysis_dir, paper["id"]).as_posix(),
            }
        )
        source_index["papers"][paper["id"]]["analysisStatus"] = "prepared"
        source_index["papers"][paper["id"]]["preparedInputPath"] = input_path.as_posix()

    count = write_jsonl(input_path, requests)
    write_json(
        manifest_path,
        {
            "schemaVersion": SCHEMA_VERSION,
            "createdAt": utc_now(),
            "model": args.model,
            "inputPath": input_path.as_posix(),
            "items": manifest_items,
        },
    )
    source_index["generatedAt"] = utc_now()
    write_json(args.source_index, source_index)
    export_public_index(args)
    print(f"Batch requests: {count}")
    print(f"Batch input: {input_path}")
    print(f"Batch manifest: {manifest_path}")
    return input_path


def submit_batch(args: argparse.Namespace) -> None:
    api_key = os.environ.get("OPENAI_API_KEY", "")
    client = OpenAIBatchClient(api_key)
    input_path = args.input
    manifest_path = input_path.with_suffix(".manifest.json")
    if not input_path.exists() or not manifest_path.exists():
        raise FileNotFoundError("The batch input and matching .manifest.json file are both required.")
    manifest = load_json(manifest_path, {})
    uploaded = client.upload_batch_file(input_path)
    batch = client.create_batch(
        uploaded["id"],
        metadata={"project": "lmi-paper-agent", "schema_version": str(SCHEMA_VERSION)},
    )
    registry = load_json(args.batch_registry, {"schemaVersion": 1, "jobs": []})
    registry["jobs"].append(
        {
            "batchId": batch["id"],
            "inputFileId": uploaded["id"],
            "inputPath": input_path.as_posix(),
            "manifestPath": manifest_path.as_posix(),
            "model": manifest.get("model", ""),
            "items": manifest.get("items", []),
            "status": batch.get("status", "validating"),
            "submittedAt": utc_now(),
            "checkedAt": utc_now(),
            "outputFileId": "",
            "errorFileId": "",
        }
    )
    write_json(args.batch_registry, registry)

    source_index = load_json(args.source_index, default_source_index())
    for item in manifest.get("items", []):
        source_index["papers"].setdefault(item["paperId"], {})["analysisStatus"] = "submitted"
        source_index["papers"][item["paperId"]]["batchId"] = batch["id"]
        source_index["papers"][item["paperId"]].pop("preparedInputPath", None)
    source_index["generatedAt"] = utc_now()
    write_json(args.source_index, source_index)
    export_public_index(args)
    print(f"Submitted batch: {batch['id']} ({len(manifest.get('items', []))} papers)")
    return batch


def sync_batches(args: argparse.Namespace) -> None:
    api_key = os.environ.get("OPENAI_API_KEY", "")
    client = OpenAIBatchClient(api_key)
    registry = load_json(args.batch_registry, {"schemaVersion": 1, "jobs": []})
    source_index = load_json(args.source_index, default_source_index())
    imported = 0
    for job in registry.get("jobs", []):
        if job.get("status") in TERMINAL_BATCH_STATES and job.get("importedAt"):
            continue
        remote = client.retrieve_batch(job["batchId"])
        job["status"] = remote.get("status", job.get("status", "unknown"))
        job["checkedAt"] = utc_now()
        job["outputFileId"] = remote.get("output_file_id") or ""
        job["errorFileId"] = remote.get("error_file_id") or ""
        print(f"Batch {job['batchId']}: {job['status']}")
        if job["status"] in {"failed", "expired", "cancelled"}:
            manifest = load_batch_manifest(job)
            for item in manifest.get("items", []):
                meta = source_index["papers"].setdefault(item["paperId"], {})
                meta["analysisStatus"] = "batch_failed"
                meta["lastError"] = f"OpenAI batch ended with status {job['status']}"
            job["importedAt"] = utc_now()
            continue
        if job["status"] == "completed" and not job["outputFileId"]:
            manifest = load_batch_manifest(job)
            for item in manifest.get("items", []):
                meta = source_index["papers"].setdefault(item["paperId"], {})
                meta["analysisStatus"] = "batch_failed"
                meta["lastError"] = "OpenAI batch completed without an output file"
            job["importedAt"] = utc_now()
            continue
        if job["status"] != "completed" or not job["outputFileId"]:
            continue
        output_text = client.download_file(job["outputFileId"])
        output_path = args.cache_dir / "batch_outputs" / f"{job['batchId']}.jsonl"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output_text, encoding="utf-8")
        manifest = load_batch_manifest(job)
        manifest_by_custom_id = {item["customId"]: item for item in manifest.get("items", [])}
        for line in output_text.splitlines():
            if not line.strip():
                continue
            custom_id, analysis, error = parse_batch_output_line(line)
            item = manifest_by_custom_id.get(custom_id)
            if not item:
                continue
            meta = source_index["papers"].setdefault(item["paperId"], {})
            if error or analysis is None:
                meta["analysisStatus"] = "failed"
                meta["lastError"] = (error or "Unknown batch output error")[:500]
                continue
            errors = validate_analysis(analysis)
            if analysis.get("evidence_level") != item.get("evidenceLevel"):
                errors.append("analysis evidence_level does not match the supplied source")
            expected_figures = item.get("figureLabels", [])
            if item.get("evidenceLevel") == "full_text" and len(analysis.get("figure_by_figure_analysis", [])) != len(expected_figures):
                errors.append(
                    "figure analysis count does not match supplied captions "
                    f"({len(analysis.get('figure_by_figure_analysis', []))}/{len(expected_figures)})"
                )
            if errors:
                meta["analysisStatus"] = "failed_validation"
                meta["lastError"] = "; ".join(errors)[:500]
                continue
            output = {
                "schemaVersion": SCHEMA_VERSION,
                "paperId": item["paperId"],
                "doi": item.get("doi", ""),
                "title": item.get("title", ""),
                "originalUrl": item.get("originalUrl", ""),
                "generatedAt": utc_now(),
                "model": job.get("model", manifest.get("model", "")),
                "source": {
                    "provider": meta.get("provider", "Europe PMC"),
                    "evidenceLevel": item.get("evidenceLevel", ""),
                    "url": item.get("sourceUrl", ""),
                    "pmcid": item.get("pmcid", ""),
                },
                "analysis": analysis,
            }
            write_json(analysis_output_path(args.analysis_dir, item["paperId"]), output)
            meta["analysisStatus"] = "complete"
            meta["lastError"] = ""
            meta["analyzedAt"] = output["generatedAt"]
            imported += 1
        job["importedAt"] = utc_now()

    write_json(args.batch_registry, registry)
    source_index["generatedAt"] = utc_now()
    write_json(args.source_index, source_index)
    export_public_index(args)
    print(f"Imported analyses: {imported}")


def export_public_index(args: argparse.Namespace) -> None:
    papers = load_papers(args.papers_file)
    source_index = load_json(args.source_index, default_source_index())
    public_papers: dict[str, dict] = {}
    counts = {
        "total": len(papers),
        "complete": 0,
        "fullTextReady": 0,
        "abstractReady": 0,
        "sourceUnavailable": 0,
        "pendingSource": 0,
    }
    public_root = args.public_index.parent
    for paper in papers:
        meta = source_index["papers"].get(paper["id"], {})
        output_path = analysis_output_path(args.analysis_dir, paper["id"])
        if output_path.exists():
            status = "complete"
            counts["complete"] += 1
        elif meta.get("analysisStatus") in {"prepared", "submitted"}:
            status = meta["analysisStatus"]
        elif meta.get("status") == "source_ready":
            status = "ready"
        elif meta.get("status") in {"not_found", "source_unavailable"}:
            status = "source_unavailable"
            counts["sourceUnavailable"] += 1
        else:
            status = "pending_source"
            counts["pendingSource"] += 1

        level = meta.get("evidenceLevel")
        if status != "complete":
            if level == "full_text":
                counts["fullTextReady"] += 1
            elif level == "abstract":
                counts["abstractReady"] += 1
        entry = {
            "status": status,
            "evidenceLevel": level,
            "sourceProvider": meta.get("provider", ""),
            "sourceUrl": meta.get("sourceUrl", ""),
            "figureCount": meta.get("figureCount"),
            "updatedAt": meta.get("analyzedAt") or meta.get("checkedAt"),
        }
        if status == "complete":
            try:
                entry["analysisPath"] = output_path.relative_to(public_root).as_posix()
            except ValueError:
                entry["analysisPath"] = output_path.as_posix()
        public_papers[paper["id"]] = entry

    write_json(
        args.public_index,
        {
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": utc_now(),
            "stats": counts,
            "papers": public_papers,
        },
    )
    print(
        "Analysis index: "
        f"{counts['complete']}/{counts['total']} complete, "
        f"{counts['fullTextReady']} full text ready, "
        f"{counts['abstractReady']} abstract ready"
    )


def print_status(args: argparse.Namespace) -> None:
    export_public_index(args)
    payload = load_json(args.public_index, {})
    print(json.dumps(payload.get("stats", {}), ensure_ascii=False, indent=2))


def run_cycle(args: argparse.Namespace) -> None:
    args.limit = 0
    args.refresh = False
    args.force = False
    discover_sources(args)
    sync_batches(args)

    registry = load_json(args.batch_registry, {"schemaVersion": 1, "jobs": []})
    active = sum(1 for job in registry.get("jobs", []) if job.get("status") not in TERMINAL_BATCH_STATES)
    slots = max(0, args.max_active_batches - active)
    to_submit = min(max(0, args.batch_count), slots)
    if to_submit == 0:
        print(f"No submission slots available ({active} active batches).")
        export_public_index(args)
        return

    args.limit = max(1, args.papers_per_batch)
    submitted = 0
    for _ in range(to_submit):
        input_path = build_batch(args)
        if input_path is None:
            break
        args.input = input_path
        submit_batch(args)
        submitted += 1
    export_public_index(args)
    print(f"Analysis cycle submitted {submitted} new batches; {active + submitted} active total.")


def prepare_source(
    paper: dict,
    source_meta: dict,
    cache_dir: Path,
    client: EuropePmcClient,
) -> dict:
    cache_path = source_cache_path(cache_dir, paper["id"])
    source = load_json(cache_path, {})
    if not source:
        records = client.discover_many([paper.get("doi", "")], batch_size=1)
        record = records.get(normalize_doi(paper.get("doi")))
        if not record or not record.evidence_level:
            raise RuntimeError("Europe PMC source material is no longer available")
        source = record.to_dict()

    level = source.get("evidence_level") or source_meta.get("evidenceLevel")
    if level == "full_text" and not source.get("article"):
        pmcid = source.get("pmcid") or source_meta.get("pmcid")
        if not pmcid:
            raise RuntimeError("Full-text source is missing a PMCID")
        source["article"] = extract_article(client.fetch_full_text_xml(pmcid), pmcid)
        source["source_url"] = source["article"]["source_url"]
    for figure in (source.get("article") or {}).get("figures", []):
        if not figure.get("asset") and figure.get("image_url"):
            figure["asset"] = figure["image_url"].rsplit("/", 1)[-1]
    if level == "abstract" and not source.get("abstract"):
        raise RuntimeError("Abstract source is empty")
    if not source.get("source_url") and source.get("pmid"):
        source["source_url"] = f"https://europepmc.org/article/MED/{source['pmid']}"
    source["evidence_level"] = level
    write_json(cache_path, source)
    return source


def is_retry_due(meta: dict, retry_before: datetime) -> bool:
    if meta.get("status") == "source_ready":
        return False
    checked_at = parse_datetime(meta.get("checkedAt"))
    return checked_at is None or checked_at <= retry_before


def load_papers(path: Path) -> list[dict]:
    payload = load_json(path, {})
    papers = payload.get("papers")
    if not isinstance(papers, list):
        raise ValueError(f"{path} does not contain a papers list")
    return papers


def load_batch_manifest(job: dict) -> dict:
    path = Path(job.get("manifestPath", ""))
    if job.get("manifestPath") and path.exists():
        return load_json(path, {})
    return {
        "model": job.get("model", ""),
        "items": job.get("items", []),
    }


def source_cache_path(cache_dir: Path, paper_id: str) -> Path:
    key = analysis_key(paper_id)
    return cache_dir / "sources" / key[:2] / f"{key}.json"


def analysis_output_path(analysis_dir: Path, paper_id: str) -> Path:
    key = analysis_key(paper_id)
    return analysis_dir / key[:2] / f"{key}.json"


def analysis_key(paper_id: str) -> str:
    return hashlib.sha256(paper_id.encode("utf-8")).hexdigest()[:32]


def default_source_index() -> dict:
    return {"schemaVersion": 1, "generatedAt": None, "papers": {}}


def load_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(path.name + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)


def parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
