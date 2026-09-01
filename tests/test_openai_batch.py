from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from paper_agent.openai_batch import OpenAIBatchClient


class OpenAIBatchClientTests(unittest.TestCase):
    def test_waits_until_uploaded_file_is_processed(self) -> None:
        client = OpenAIBatchClient("test-key")
        client.retrieve_file = Mock(
            side_effect=[
                {"id": "file-test", "purpose": "batch", "status": "uploaded"},
                {"id": "file-test", "purpose": "batch", "status": "processed"},
            ]
        )

        with patch("paper_agent.openai_batch.time.sleep") as sleep:
            result = client.wait_for_file_ready(
                "file-test",
                timeout_seconds=30,
                poll_seconds=1,
                settle_seconds=5,
            )

        self.assertEqual("processed", result["status"])
        self.assertEqual(2, client.retrieve_file.call_count)
        self.assertEqual([unittest.mock.call(1), unittest.mock.call(5)], sleep.call_args_list)

    def test_accepts_retrievable_file_when_deprecated_status_is_missing(self) -> None:
        client = OpenAIBatchClient("test-key")
        client.retrieve_file = Mock(return_value={"id": "file-test", "purpose": "batch"})

        with patch("paper_agent.openai_batch.time.sleep") as sleep:
            result = client.wait_for_file_ready("file-test", settle_seconds=0)

        self.assertEqual("file-test", result["id"])
        sleep.assert_not_called()

    def test_rejects_file_processing_error(self) -> None:
        client = OpenAIBatchClient("test-key")
        client.retrieve_file = Mock(
            return_value={
                "id": "file-test",
                "purpose": "batch",
                "status": "error",
                "status_details": "invalid JSONL",
            }
        )

        with self.assertRaisesRegex(RuntimeError, "invalid JSONL"):
            client.wait_for_file_ready("file-test", settle_seconds=0)


if __name__ == "__main__":
    unittest.main()
