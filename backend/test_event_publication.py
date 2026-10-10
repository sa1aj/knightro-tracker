import importlib.util
import os
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scraper'))
import export_events
import scrape_and_publish


class PublicationTests(unittest.TestCase):
    def test_failed_or_limited_scrape_never_replaces_the_production_feed(self):
        for args, result in [(['scrape_and_publish.py'], 1), (['scrape_and_publish.py','--limit','1'], 0)]:
            with patch.object(sys, 'argv', args), patch.dict(os.environ, {'EVENTS_BUCKET':'test-bucket'}), \
                 patch.object(scrape_and_publish.subprocess, 'run', return_value=SimpleNamespace(returncode=result)), \
                 patch.object(scrape_and_publish, 'publish') as publish, patch.object(scrape_and_publish, 'export_from_environment') as export:
                self.assertEqual(scrape_and_publish.main(), result)
                publish.assert_not_called(); export.assert_not_called()

    def test_complete_run_exports_then_uploads_and_reports_publication_failure(self):
        with patch.object(sys, 'argv', ['scrape_and_publish.py']), \
             patch.dict(os.environ, {'EVENTS_BUCKET':'test-bucket'}), \
             patch.object(scrape_and_publish.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
             patch.object(scrape_and_publish, 'export_from_environment', return_value={'events':[]}) as export, \
             patch.object(scrape_and_publish, 'publish', side_effect=OSError('private diagnostic')) as publish:
            self.assertEqual(scrape_and_publish.main(), 1)
            export.assert_called_once(); publish.assert_called_once()

    @unittest.skipUnless(importlib.util.find_spec('sqlalchemy'), 'Install scraper requirements for the PostgreSQL export adapter checks')
    def test_publication_uses_the_same_database_override_as_the_scrape(self):
        with patch.object(sys, 'argv', ['scrape_and_publish.py', '--database-url', 'sqlite:///chosen.db']), \
             patch.dict(os.environ, {'EVENTS_BUCKET':'test-bucket'}), \
             patch.object(scrape_and_publish.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
             patch.object(scrape_and_publish, 'export_from_environment', return_value={'events':[]}) as export, \
             patch.object(scrape_and_publish, 'publish'):
            self.assertEqual(scrape_and_publish.main(), 0)
            self.assertEqual(export.call_args.kwargs['database_url'], 'sqlite:///chosen.db')

    @unittest.skipUnless(importlib.util.find_spec('sqlalchemy'), 'Install scraper requirements for the PostgreSQL export adapter checks')
    def test_sqlalchemy_export_handles_native_dates_json_and_boolean_listing(self):
        from sqlalchemy import Boolean, Column, DateTime, Float, JSON, MetaData, String, Table, create_engine
        with tempfile.TemporaryDirectory(prefix='knightro-export-adapter-') as directory:
            root = Path(directory)
            db = root / 'events.db'
            url = 'sqlite:///' + db.as_posix()
            engine = create_engine(url)
            table = Table('events', MetaData(), Column('event_id',String,primary_key=True),
                Column('name',String),Column('description',String),Column('starts_at',DateTime),Column('ends_at',DateTime),
                Column('location',String),Column('latitude',Float),Column('longitude',Float),Column('hosts',JSON),
                Column('source_url',String),Column('is_listed',Boolean),Column('status',String))
            table.metadata.create_all(engine)
            row = {'name':'Knightro visit','description':'Meet Knightro','starts_at':datetime(2026,10,10,14),
                'ends_at':datetime(2026,10,10,16),'location':'Student Union','latitude':28.6,'longitude':-81.2,
                'hosts':['UCF'],'source_url':'https://example.org','is_listed':True,'status':None}
            with engine.begin() as connection:
                connection.execute(table.insert(), [{**row,'event_id':'valid'}, {**row,'event_id':'cancelled','status':'CANCELLED'},
                                                     {**row,'event_id':'unlisted','is_listed':False}])
            engine.dispose()
            with patch.dict(os.environ, {'DATABASE_URL':url}, clear=True):
                result = export_events.export_from_environment(root/'events.json',now=datetime(2026,10,10,tzinfo=timezone.utc))
            self.assertEqual([e['eventId'] for e in result['events']], ['valid'])
            self.assertEqual(result['events'][0]['hosts'], ['UCF'])
            self.assertEqual(result['events'][0]['description'], 'Meet Knightro')
            self.assertEqual(result['events'][0]['startsAt'], 1791640800)
