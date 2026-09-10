import copy
import unittest

from paper_agent.audit_classification_alignment import audit_alignment


class ClassificationAlignmentTests(unittest.TestCase):
    def test_replay_compares_final_abstract_without_mutating_records(self):
        papers = [{"id": "p1", "title": "Study", "journal": "Example", "topics": [],
                   "abstract": "Aging", "relevanceRaw": 0, "priority": "Archive only"}]
        original = copy.deepcopy(papers)
        profile = {"keyword_groups": {"aging": {"weight": 3, "terms": ["aging"]}}}
        rubric = {"themes": {"aging": {"display": "Aging", "keyword_groups": ["aging"]}}}
        result = audit_alignment(papers, profile, [], rubric)
        self.assertEqual(result["counts"]["topic_drift"], 1)
        self.assertEqual(result["counts"]["score_drift"], 1)
        self.assertEqual(result["counts"]["priority_drift"], 0)
        self.assertEqual(result["counts"]["unclassified_with_replayed_topics"], 1)
        self.assertEqual(result["changed"][0]["replayed_topics"], ["Aging"])
        self.assertEqual(papers, original)

    def test_empty_input_has_no_changes(self):
        result = audit_alignment([], {}, [], {})
        self.assertEqual(result["changed"], [])
        self.assertTrue(all(value == 0 for value in result["counts"].values()))
