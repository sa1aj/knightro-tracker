import importlib.util
from pathlib import Path
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
import tempfile
import unittest

module_path = Path(__file__).resolve().parents[1] / "scraper/export_events.py"
spec = importlib.util.spec_from_file_location("event_export", module_path)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def test_filters_and_preserves_timezone_and_unmapped_events(self):
        with tempfile.TemporaryDirectory(prefix='knightro-export-test-') as directory:
            root = Path(directory)
            database, output = root / "events.db", root / "feed.json"
            with closing(sqlite3.connect(database)) as db:
                db.execute("""CREATE TABLE events(event_id TEXT,name TEXT,starts_at TEXT,ends_at TEXT,
                    location TEXT,latitude REAL,longitude REAL,hosts TEXT,source_url TEXT,is_listed INTEGER,status TEXT)""")
                for eid, start, end, listed, status in [
                    ("valid","2026-10-10T10:00:00-04:00","2026-10-10T12:00:00-04:00",1,"CONFIRMED"),
                    ("past","2026-10-08T10:00:00","2026-10-08T12:00:00",1,"CONFIRMED"),
                    ("cancelled","2026-10-10T10:00:00","2026-10-10T12:00:00",1,"CANCELLED"),
                    ("missing","2026-10-10T10:00:00","2026-10-10T12:00:00",0,"CONFIRMED"),
                    ("far","2026-12-10T10:00:00","2026-12-10T12:00:00",1,"CONFIRMED"),
                    ("null-status","2026-10-11T10:00:00","2026-10-11T12:00:00",1,None),
                ]:
                    db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (eid,eid,start,end,"Student Union",None,None,'["UCF"]',"https://knightconnect.campuslabs.com/",listed,status))
                db.commit()
            result = exporter.export_events(database, output, now=datetime(2026,10,10,tzinfo=timezone.utc))
            self.assertEqual([e["eventId"] for e in result["events"]],["valid","null-status"])
            self.assertEqual(datetime.fromtimestamp(result["events"][0]["startsAt"],timezone.utc).hour,14)
            self.assertIsNone(result["events"][0]["lat"])
            self.assertTrue(output.is_file())
            self.assertEqual(len(list(root.glob("*.tmp"))),0)
            with self.assertRaises(FileNotFoundError):
                exporter.export_events(root/"absent.db",output)
            self.assertFalse((root/"absent.db").exists())


if __name__ == "__main__":
    unittest.main()
