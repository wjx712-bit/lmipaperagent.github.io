import json
import unittest

from paper_agent.analysis_schema import validate_analysis
from paper_agent.europe_pmc import article_text, extract_article
from paper_agent.openai_batch import (
    make_batch_request,
    parse_batch_output_line,
)


ARTICLE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<article xmlns:xlink="http://www.w3.org/1999/xlink">
  <front>
    <article-meta>
      <title-group><article-title>Metabolic test article</article-title></title-group>
      <abstract><p>Adipocyte inflammation was examined.</p></abstract>
    </article-meta>
  </front>
  <body>
    <sec>
      <title>Results</title>
      <p>Knockout mice had improved insulin sensitivity.</p>
      <fig id="f1">
        <label>Figure 1</label>
        <caption><p>Glucose tolerance in knockout mice.</p></caption>
        <graphic xlink:href="figure1.jpg" />
      </fig>
    </sec>
  </body>
</article>
"""


class EuropePmcExtractionTests(unittest.TestCase):
    def test_extracts_sections_figures_and_asset_url(self):
        article = extract_article(ARTICLE_XML, "PMC123")

        self.assertEqual(article["title"], "Metabolic test article")
        self.assertIn("improved insulin sensitivity", article_text(article))
        self.assertEqual(article["figures"][0]["label"], "Figure 1")
        self.assertEqual(
            article["figures"][0]["image_url"],
            "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123/bin/figure1.jpg",
        )


class BatchFormattingTests(unittest.TestCase):
    def test_batch_request_uses_structured_output_and_images(self):
        article = extract_article(ARTICLE_XML, "PMC123")
        article["figures"][0]["image_data_url"] = "data:image/jpeg;base64,AA=="
        request = make_batch_request(
            custom_id="paper-123",
            paper={
                "title": "Metabolic test article",
                "authors": ["A. Author"],
                "journal": "Nature Metabolism",
                "publishedAt": "2026-01-01",
                "doi": "10.1000/test",
                "url": "https://doi.org/10.1000/test",
            },
            source={"evidence_level": "full_text", "article": article},
            model="test-model",
        )

        body = request["body"]
        self.assertTrue(body["text"]["format"]["strict"])
        self.assertEqual(body["text"]["format"]["name"], "paper_analysis")
        content_types = [item["type"] for item in body["input"][1]["content"]]
        self.assertIn("input_image", content_types)

    def test_parses_batch_response_by_custom_id(self):
        analysis = valid_analysis()
        line = json.dumps(
            {
                "custom_id": "paper-123",
                "response": {
                    "status_code": 200,
                    "body": {
                        "output": [
                            {
                                "type": "message",
                                "content": [{"type": "output_text", "text": json.dumps(analysis)}],
                            }
                        ]
                    },
                },
            }
        )

        custom_id, parsed, error = parse_batch_output_line(line)

        self.assertEqual(custom_id, "paper-123")
        self.assertEqual(parsed, analysis)
        self.assertIsNone(error)

    def test_abstract_analysis_rejects_figure_claims(self):
        analysis = valid_analysis()
        analysis["evidence_level"] = "abstract"
        analysis["figure_by_figure_analysis"] = [
            {
                "figure": "Figure 1",
                "question": "q",
                "approach": "a",
                "result": "r",
                "interpretation": "i",
                "confidence": "low",
            }
        ]

        self.assertIn(
            "abstract-only analysis must not include figure analysis",
            validate_analysis(analysis),
        )

def valid_analysis():
    return {
        "evidence_level": "full_text",
        "research_background": "background",
        "main_question": "question",
        "hypothesis": "hypothesis",
        "experimental_models": [],
        "methods": [],
        "key_results": [],
        "summary": "summary",
        "conclusion": "conclusion",
        "limitations": [],
        "figure_by_figure_analysis": [],
        "source_caveats": [],
    }


if __name__ == "__main__":
    unittest.main()
