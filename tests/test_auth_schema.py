import unittest
from pathlib import Path


MIGRATION = Path("supabase/migrations/202608130001_auth_and_reviews.sql")


class AuthSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = MIGRATION.read_text(encoding="utf-8").lower()

    def test_bootstraps_expected_google_admin(self):
        self.assertIn("wjx712@gmail.com", self.sql)
        self.assertIn("is_bootstrap_admin", self.sql)

    def test_enables_rls_on_private_tables(self):
        self.assertIn("alter table public.profiles enable row level security", self.sql)
        self.assertIn("alter table public.paper_reviews enable row level security", self.sql)

    def test_reviews_are_visible_only_to_owner_or_admin(self):
        self.assertIn("user_id = auth.uid() or public.is_lmi_admin()", self.sql)
        self.assertIn("users read own reviews; admins read all", self.sql)

    def test_only_approved_users_can_write_reviews(self):
        self.assertGreaterEqual(self.sql.count("status = 'approved'"), 4)
        self.assertIn("approved users create own reviews", self.sql)
        self.assertIn("approved users update own reviews", self.sql)

    def test_anon_role_has_no_table_access(self):
        self.assertIn("revoke all on public.profiles from anon", self.sql)
        self.assertIn("revoke all on public.paper_reviews from anon", self.sql)


if __name__ == "__main__":
    unittest.main()
