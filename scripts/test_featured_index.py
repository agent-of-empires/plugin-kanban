"""Tests for featured_index.py. Run: python -m unittest discover -s scripts"""

import tomllib
import unittest

from featured_index import update_featured_versions

ID = "agent-of-empires.kanban"
SOURCE = "gh:agent-of-empires/plugin-kanban"
H1 = "sha256:" + "1" * 64
H2 = "sha256:" + "2" * 64

OTHER = """# comment kept
[plugins."agent-of-empires.cron"]
source = "gh:agent-of-empires/plugin-cron"
versions = {"1.0.0" = "sha256:%s"}
""" % ("0" * 64)


class UpdateFeaturedVersions(unittest.TestCase):
    def test_creates_missing_entry(self):
        text, changed = update_featured_versions(OTHER, ID, SOURCE, "1.0.0", H1)
        self.assertTrue(changed)
        self.assertIn("# comment kept", text)
        plugins = tomllib.loads(text)["plugins"]
        self.assertEqual(plugins[ID], {"source": SOURCE, "versions": {"1.0.0": H1}})
        self.assertIn("agent-of-empires.cron", plugins)

    def test_adds_version_and_is_idempotent(self):
        text, _ = update_featured_versions(OTHER, ID, SOURCE, "1.0.0", H1)
        text, changed = update_featured_versions(text, ID, SOURCE, "1.1.0", H2)
        self.assertTrue(changed)
        self.assertEqual(tomllib.loads(text)["plugins"][ID]["versions"], {"1.0.0": H1, "1.1.0": H2})
        same, changed = update_featured_versions(text, ID, SOURCE, "1.1.0", H2)
        self.assertFalse(changed)
        self.assertEqual(same, text)

    def test_refuses_repinning_a_version(self):
        text, _ = update_featured_versions(OTHER, ID, SOURCE, "1.0.0", H1)
        with self.assertRaises(ValueError):
            update_featured_versions(text, ID, SOURCE, "1.0.0", H2)

    def test_refuses_another_source(self):
        with self.assertRaises(ValueError):
            update_featured_versions(OTHER, "agent-of-empires.cron", SOURCE, "2.0.0", H1)

    def test_refuses_malformed_hash(self):
        with self.assertRaises(ValueError):
            update_featured_versions(OTHER, ID, SOURCE, "1.0.0", "sha256:nope")


if __name__ == "__main__":
    unittest.main()
