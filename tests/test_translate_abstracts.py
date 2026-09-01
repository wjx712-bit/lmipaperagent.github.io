from __future__ import annotations

import json
import unittest

from paper_agent.translate_abstracts import (
    apply_batch_output,
    due_papers,
    make_translation_request,
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
