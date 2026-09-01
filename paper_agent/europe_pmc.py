from __future__ import annotations

import base64
import html
import io
import mimetypes
import re
import tarfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Iterable

import requests

from paper_agent.abstract_text import strip_leading_abstract_label

SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
FULL_TEXT_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
ARTICLE_URL = "https://europepmc.org/articles/{pmcid}"
MED_ARTICLE_URL = "https://europepmc.org/article/MED/{pmid}"
NCBI_ASSET_URL = "https://www.ncbi.nlm.nih.gov/pmc/articles/{pmcid}/bin/{asset}"
OA_PACKAGE_URL = "https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi"
XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class SourceRecord:
    doi: str
    pmid: str
    pmcid: str
    title: str
    abstract: str
    is_open_access: bool
    has_full_text: bool
    source_url: str

    @property
    def evidence_level(self) -> str | None:
        if self.pmcid and self.has_full_text and self.is_open_access:
            return "full_text"
        if self.abstract:
            return "abstract"
        return None

    def to_dict(self) -> dict:
        return {
            "doi": self.doi,
            "pmid": self.pmid,
            "pmcid": self.pmcid,
            "title": self.title,
            "abstract": self.abstract,
            "is_open_access": self.is_open_access,
            "has_full_text": self.has_full_text,
            "source_url": self.source_url,
            "evidence_level": self.evidence_level,
        }


class EuropePmcClient:
    def __init__(
        self,
        session: requests.Session | None = None,
        timeout: float = 45,
        pause_seconds: float = 0.1,
    ) -> None:
        self.session = session or requests.Session()
        self.session.headers.setdefault(
            "User-Agent",
            "LMI-Paper-Agent/1.0 (https://github.com/wjx712-bit/lmipaperagent.github.io)",
        )
        self.timeout = timeout
        self.pause_seconds = pause_seconds

    def discover_many(self, dois: Iterable[str], batch_size: int = 20) -> dict[str, SourceRecord]:
        normalized = list(dict.fromkeys(normalize_doi(doi) for doi in dois if normalize_doi(doi)))
        discovered: dict[str, SourceRecord] = {}
        for offset in range(0, len(normalized), max(1, batch_size)):
            chunk = normalized[offset : offset + max(1, batch_size)]
            query = " OR ".join(f'DOI:\"{doi}\"' for doi in chunk)
            payload = self._get_json(
                SEARCH_URL,
                params={
                    "query": query,
                    "format": "json",
                    "resultType": "core",
                    "pageSize": max(25, len(chunk) * 2),
                },
            )
            for item in payload.get("resultList", {}).get("result", []):
                record = source_record_from_result(item)
                if record.doi in chunk:
                    discovered[record.doi] = record
            if self.pause_seconds:
                time.sleep(self.pause_seconds)
        return discovered

    def fetch_full_text_xml(self, pmcid: str) -> str:
        response = self.session.get(
            FULL_TEXT_URL.format(pmcid=pmcid),
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.text

    def fetch_figure_data_urls(
        self,
        pmcid: str,
        assets: Iterable[str],
        package_cache_path=None,
        max_total_bytes: int = 12_000_000,
    ) -> dict[str, str]:
        requested = {asset for asset in assets if asset}
        if not requested:
            return {}
        package_bytes = None
        if package_cache_path and package_cache_path.exists():
            package_bytes = package_cache_path.read_bytes()
        if package_bytes is None:
            package_bytes = self._download_oa_package(pmcid)
            if package_cache_path:
                package_cache_path.parent.mkdir(parents=True, exist_ok=True)
                package_cache_path.write_bytes(package_bytes)

        encoded: dict[str, str] = {}
        total_bytes = 0
        with tarfile.open(fileobj=io.BytesIO(package_bytes), mode="r:gz") as archive:
            members = {
                member.name.rsplit("/", 1)[-1]: member
                for member in archive.getmembers()
                if member.isfile()
            }
            for asset in requested:
                member = members.get(asset.rsplit("/", 1)[-1])
                if not member:
                    continue
                mime_type = mimetypes.guess_type(asset)[0] or "application/octet-stream"
                if mime_type not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
                    continue
                extracted = archive.extractfile(member)
                if extracted is None:
                    continue
                content = extracted.read()
                if total_bytes + len(content) > max_total_bytes:
                    continue
                encoded[asset] = f"data:{mime_type};base64,{base64.b64encode(content).decode('ascii')}"
                total_bytes += len(content)
        return encoded

    def _download_oa_package(self, pmcid: str) -> bytes:
        response = self.session.get(OA_PACKAGE_URL, params={"id": pmcid}, timeout=self.timeout)
        response.raise_for_status()
        root = ET.fromstring(response.text)
        link = next((item for item in root.findall(".//link") if item.attrib.get("format") == "tgz"), None)
        if link is None or not link.attrib.get("href"):
            raise RuntimeError(f"PMC OA package is not available for {pmcid}")
        https_url = link.attrib["href"].replace("ftp://ftp.ncbi.nlm.nih.gov", "https://ftp.ncbi.nlm.nih.gov")
        candidates = [
            https_url,
            https_url.replace("/pub/pmc/oa_package/", "/pub/pmc/deprecated/oa_package/"),
        ]
        for candidate in dict.fromkeys(candidates):
            package = self.session.get(candidate, timeout=max(self.timeout, 120))
            if package.ok:
                return package.content
        raise RuntimeError(f"Unable to download PMC OA package for {pmcid}")

    def _get_json(self, url: str, params: dict) -> dict:
        response = self.session.get(url, params=params, timeout=self.timeout)
        response.raise_for_status()
        return response.json()


def source_record_from_result(item: dict) -> SourceRecord:
    pmcid = clean_text(item.get("pmcid", "")).upper()
    pmid = clean_text(item.get("pmid", ""))
    return SourceRecord(
        doi=normalize_doi(item.get("doi", "")),
        pmid=pmid,
        pmcid=pmcid,
        title=clean_text(item.get("title", "")),
        abstract=strip_leading_abstract_label(clean_text(item.get("abstractText", ""))),
        is_open_access=str(item.get("isOpenAccess", "")).upper() == "Y",
        has_full_text=str(item.get("inEPMC", "")).upper() == "Y",
        source_url=(
            ARTICLE_URL.format(pmcid=pmcid)
            if pmcid
            else MED_ARTICLE_URL.format(pmid=pmid) if pmid else ""
        ),
    )


def extract_article(xml_text: str, pmcid: str) -> dict:
    root = ET.fromstring(xml_text)
    title = element_text(root.find(".//article-title"))
    abstract = strip_leading_abstract_label(element_text(root.find(".//abstract")))
    sections: list[dict[str, str]] = []
    body = root.find(".//body")
    if body is not None:
        for section in body.iter("sec"):
            heading = element_text(section.find("./title")) or "Untitled section"
            paragraphs = [element_text(paragraph) for paragraph in section.findall("./p")]
            text = "\n".join(part for part in paragraphs if part)
            if text:
                sections.append({"title": heading, "text": text})

    figures: list[dict[str, str]] = []
    for position, figure in enumerate(root.findall(".//fig"), start=1):
        label = element_text(figure.find("./label")) or f"Figure {position}"
        caption = element_text(figure.find("./caption"))
        graphic = figure.find(".//graphic")
        asset = clean_text(graphic.attrib.get(XLINK_HREF, "")) if graphic is not None else ""
        figures.append(
            {
                "id": clean_text(figure.attrib.get("id", "")),
                "label": label,
                "caption": caption,
                "asset": asset,
                "image_url": NCBI_ASSET_URL.format(pmcid=pmcid, asset=asset) if asset else "",
            }
        )

    return {
        "title": title,
        "abstract": abstract,
        "sections": sections,
        "figures": figures,
        "source_url": ARTICLE_URL.format(pmcid=pmcid),
    }


def article_text(article: dict, max_characters: int = 180_000) -> str:
    blocks: list[str] = []
    if article.get("abstract"):
        blocks.append(f"ABSTRACT\n{article['abstract']}")
    for section in article.get("sections", []):
        blocks.append(f"SECTION: {section['title']}\n{section['text']}")
    return "\n\n".join(blocks)[:max_characters]


def figure_text(article: dict) -> str:
    blocks = []
    for figure in article.get("figures", []):
        blocks.append(f"{figure['label']}\n{figure['caption']}")
    return "\n\n".join(blocks)


def element_text(element: ET.Element | None) -> str:
    if element is None:
        return ""
    return clean_text(" ".join(element.itertext()))


def normalize_doi(value: str | None) -> str:
    doi = clean_text(value or "").lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if doi.startswith(prefix):
            doi = doi[len(prefix) :]
    return doi.strip()


def clean_text(value: str | None) -> str:
    return SPACE_RE.sub(" ", html.unescape(TAG_RE.sub(" ", str(value or "")))).strip()
