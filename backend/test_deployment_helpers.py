"""Checks for private configuration, push key compatibility, and WAL-safe backups."""
import base64
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'deploy/aws' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeploymentHelpers(unittest.TestCase):
    def setUp(self):
        self.renderer = load('render_environment')
        self.secret = {'SMTP_HOST': 'email-smtp.us-east-1.amazonaws.com', 'SMTP_PORT': '587',
                       'SMTP_SECURITY': 'starttls', 'SMTP_FROM': 'mail@operator.org',
                       'SMTP_USER': 'test-only', 'SMTP_PASSWORD': 'test-only', 'ADMIN_EMAILS': '',
                       'PROXY_TOKEN': 'a' * 64}

    def render(self, secret=None, origin='https://tracker.operator.org'):
        return self.renderer.environment(self.secret if secret is None else secret,
                                         origin, 'api.operator.org', 'operator@operator.org')

    def test_configuration_is_private_and_explicit(self):
        app, proxy = self.render()
        self.assertEqual(app['PUBLIC_ORIGIN'], 'https://tracker.operator.org')
        self.assertEqual(app['TRUSTED_PROXY_TOKEN'], proxy['PROXY_TOKEN'])
        self.assertNotIn('PROXY_TOKEN', app)
        self.assertNotIn('SMTP_PASSWORD', proxy)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'app.env'
            self.renderer.write_private(output, app)
            self.assertIn('ADMIN_EMAILS=\n', output.read_text())

    def test_rejects_incomplete_and_injected_configuration(self):
        for invalid in ([], {**self.secret, 'SMTP_PASSWORD': 'x\nPUBLIC_ORIGIN=bad'},
                        {**self.secret, 'VAPID_PUBLIC_KEY': 'partial'},
                        {k: v for k, v in self.secret.items() if k != 'ADMIN_EMAILS'},
                        {**self.secret, 'PROXY_TOKEN': 'short'}):
            with self.subTest(config_type=type(invalid).__name__), self.assertRaises(ValueError):
                self.render(invalid)
        for origin in ('http://tracker.operator.org', 'https://u:p@tracker.operator.org',
                       'https://tracker.operator.org/path', 'https://tracker.operator.org?query=1'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                self.render(origin=origin)

    def test_generated_keys_round_trip(self):
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid
        values = load('generate_keys').generate('operator@operator.org')
        key = Vapid.from_string(values['VAPID_PRIVATE_KEY'])
        public = key.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        self.assertEqual(base64.urlsafe_b64encode(public).decode().rstrip('='), values['VAPID_PUBLIC_KEY'])
        self.assertGreaterEqual(len(values['PROXY_TOKEN']), 40)
        self.assertEqual(values['VAPID_SUBJECT'], 'mailto:operator@operator.org')

    def test_backup_includes_committed_wal_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source.db', Path(directory) / 'copy.db'
            original = sqlite3.connect(source)
            try:
                original.execute('PRAGMA journal_mode=WAL')
                original.execute('CREATE TABLE items (value TEXT)')
                original.execute("INSERT INTO items VALUES ('committed')")
                original.commit()
                self.assertTrue(Path(str(source) + '-wal').exists())
                helper = load('backup_database')
                helper.backup(source, target)
                copy = sqlite3.connect(target)
                try:
                    self.assertEqual(copy.execute('SELECT value FROM items').fetchone()[0], 'committed')
                finally:
                    copy.close()
                with self.assertRaises(FileExistsError):
                    helper.backup(source, target)
            finally:
                original.close()
