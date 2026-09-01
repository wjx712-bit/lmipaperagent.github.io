from __future__ import annotations

import json
import unittest

from paper_agent.translate_abstracts import (
    apply_batch_output,
    due_papers,
    make_translation_request,
    normalize_translation,
    parse_direct_translation,
    source_hash,
)


class AbstractTranslationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.paper = {
            "id": "10.1/example",
            "title": "Adipocyte inflammation",
            "journal": "Nature Metabolism",
            "abstract": "Adipocyte inflammation changes tissue metabolism.",
        }

    def test_due_papers_excludes_current_translation_and_active_batch(self) -> None:
        empty = {"translations": {}}
        registry = {"jobs": []}
        self.assertEqual([self.paper], due_papers([self.paper], empty, registry))

        current = {
            "translations": {
                self.paper["id"]: {
                    "sourceHash": source_hash(self.paper["abstract"]),
                    "textKo": "지방세포 염증은 조직 대사를 변화시킨다.",
                }
            }
        }
        self.assertEqual([], due_papers([self.paper], current, registry))

        active = {
            "jobs": [
                {
                    "status": "in_progress",
                    "items": [{"paperId": self.paper["id"]}],
                }
            ]
        }
        self.assertEqual([], due_papers([self.paper], empty, active))

    def test_changed_abstract_is_due_again(self) -> None:
        stale = {
            "translations": {
                self.paper["id"]: {
                    "sourceHash": source_hash("Previous abstract."),
                    "textKo": "이전 번역",
                }
            }
        }
        self.assertEqual([self.paper], due_papers([self.paper], stale, {"jobs": []}))

    def test_heading_only_change_keeps_existing_translation_current(self) -> None:
        current = {
            "translations": {
                self.paper["id"]: {
                    "sourceHash": source_hash("Abstract " + self.paper["abstract"]),
                    "textKo": "지방세포 염증은 조직 대사를 변화시킨다.",
                }
            }
        }

        self.assertEqual([], due_papers([self.paper], current, {"jobs": []}))

    def test_batch_request_uses_structured_translation_output(self) -> None:
        request = make_translation_request("abstract-ko-test", self.paper, "gpt-5.4-mini")
        body = request["body"]
        self.assertEqual("gpt-5.4-mini", body["model"])
        self.assertEqual("none", body["reasoning"]["effort"])
        self.assertEqual("abstract_translation_ko", body["text"]["format"]["name"])
        self.assertIn(self.paper["abstract"], body["input"][1]["content"][0]["text"])

    def test_imports_completed_batch_translation(self) -> None:
        custom_id = "abstract-ko-test"
        translated = "지방세포 염증은 조직 대사를 변화시킨다."
        output = json.dumps(
            {
                "custom_id": custom_id,
                "response": {
                    "status_code": 200,
                    "body": {
                        "output": [
                            {
                                "type": "message",
                                "content": [
                                    {
                                        "type": "output_text",
                                        "text": json.dumps({"translation_ko": translated}, ensure_ascii=False),
                                    }
                                ],
                            }
                        ]
                    },
                },
            },
            ensure_ascii=False,
        )
        job = {
            "model": "gpt-5.4-mini",
            "items": [
                {
                    "customId": custom_id,
                    "paperId": self.paper["id"],
                    "sourceHash": source_hash(self.paper["abstract"]),
                }
            ],
        }
        translations = {"translations": {}}

        imported, errors = apply_batch_output(output, job, translations)

        self.assertEqual((1, 0), (imported, errors))
        self.assertEqual(translated, translations["translations"][self.paper["id"]]["textKo"])

    def test_parses_direct_translation_response(self) -> None:
        translated = "지방세포 염증은 조직 대사를 변화시킨다."
        response = {
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": json.dumps({"translation_ko": translated}, ensure_ascii=False),
                        }
                    ],
                }
            ]
        }

        self.assertEqual(translated, parse_direct_translation(response))

    def test_removes_echoed_title_and_journal_metadata(self) -> None:
        body = "난소 노화는 여러 장기의 기능 저하보다 먼저 나타난다."
        self.assertEqual(
            body,
            normalize_translation(
                "제목: 난소 노화 연구 저널: Nature Aging 초록: " + body
            ),
        )
        self.assertEqual(
            body,
            normalize_translation(
                "TITLE: Ovarian aging JOURNAL: Nature Aging ABSTRACT: " + body
            ),
        )
        self.assertEqual(
            body,
            normalize_translation(
                "간세포 미토콘드리아 NAD+ 저널: Nature Metabolism 초록: " + body
            ),
        )
        self.assertEqual(
            body,
            normalize_translation("제목: 난소 노화 연구  초록: " + body),
        )
        self.assertEqual(
            body,
            normalize_translation("제목: 난소 노화 연구 학술지: Nature Aging 초록: " + body),
        )
        self.assertEqual(
            body,
            normalize_translation("제목: 난소 노화 연구  " + body),
        )

    def test_keeps_normal_translation_unchanged(self) -> None:
        body = "이 초록: 표지는 문장 본문에 포함되지만 저널 메타데이터는 없다."
        self.assertEqual(body, normalize_translation(body))
