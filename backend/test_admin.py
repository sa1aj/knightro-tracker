"""Admin mode: server-side authorization, testing overrides, points, and isolated test data."""
import sqlite3
import time
import unittest
from contextlib import closing
from unittest.mock import patch

from test_server import AppTests, PHOTO

ADMIN = 'jo822842@ucf.edu'
ADMIN_GETS = ('/api/admin/users?q=a', '/api/admin/test-events', '/api/admin/test-sightings',
              '/api/admin/sightings', '/api/admin/log')
ADMIN_POSTS = ('/api/admin/mode', '/api/admin/cooldown', '/api/admin/points', '/api/admin/test-events',
               '/api/admin/test-events/delete', '/api/admin/test-sightings', '/api/admin/sightings/remove',
               '/api/admin/test-data/clear')
UNION = {'lat': 28.6018, 'long': -81.2004}


class AdminTests(AppTests):
    def admin_cookie(self, mode=True):
        cookie, _, _ = self.signup(ADMIN)
        if mode:
            status, _, state = self.request('/api/admin/mode', {'enabled': True}, cookie)
            self.assertEqual((status, state['mode']), (200, True))
        return cookie

    def test_admin_routes_reject_signed_out_regular_and_forged_requests(self):
        for path in ADMIN_GETS + ('/api/admin/state',):
            self.assertEqual(self.request(path)[0], 401, path)
        for path in ADMIN_POSTS:
            self.assertEqual(self.request(path, {'enabled': True, 'confirm': True})[0], 401, path)
        knight, session, _ = self.signup('knight@ucf.edu')
        self.assertNotIn('admin', session)  # Regular accounts never see admin fields.
        for path in ADMIN_GETS + ('/api/admin/state',):
            self.assertEqual(self.request(path, cookie=knight)[0], 403, path)
        for path in ADMIN_POSTS:
            body = {'enabled': True, 'confirm': True, 'admin': True, 'email': ADMIN, 'role': 'admin'}
            self.assertEqual(self.request(path, body, knight)[0], 403, path)
        # A valid admin cookie still cannot be used from another site.
        cookie = self.admin_cookie()
        self.assertEqual(self.request('/api/admin/cooldown', {'enabled': True}, cookie, origin='https://evil.example')[0], 403)

    def test_admin_tools_require_admin_mode_and_session_reports_state(self):
        cookie = self.admin_cookie(mode=False)
        status, _, session = self.request('/api/auth/session', cookie=cookie)
        self.assertEqual(session['admin'], {'allowed': True, 'mode': False, 'bypassCooldown': False})
        self.assertEqual(self.request('/api/admin/state', cookie=cookie)[0], 200)
        for path in ADMIN_GETS:
            self.assertEqual(self.request(path, cookie=cookie)[0], 403, path)
        self.assertEqual(self.request('/api/admin/cooldown', {'enabled': True}, cookie)[0], 403)
        self.assertEqual(self.request('/api/admin/mode', {'enabled': 'yes'}, cookie)[0], 400)
        self.assertEqual(self.request('/api/admin/mode', {'enabled': True}, cookie)[2]['mode'], True)
        self.assertEqual(self.request('/api/admin/users?q=', cookie=cookie)[0], 200)

    def test_admin_allowlist_comes_from_server_environment(self):
        with patch.dict('os.environ', {'ADMIN_EMAILS': 'other@ucf.edu'}):
            cookie, session, _ = self.signup(ADMIN)
            self.assertNotIn('admin', session)
            self.assertEqual(self.request('/api/admin/mode', {'enabled': True}, cookie)[0], 403)
            other, session, _ = self.signup('other@ucf.edu')
            self.assertTrue(session['admin']['allowed'])

    def test_admin_cooldown_bypass_is_admin_only_and_cleared_with_admin_mode(self):
        knight, _, _ = self.signup('knight@ucf.edu')
        self.assertEqual(self.post_photo({**UNION, 'photo': PHOTO}, knight)[0], 201)
        self.assertEqual(self.request('/api/camera-session', {}, knight)[0], 429)  # Normal cooldown unchanged.
        cookie = self.admin_cookie()
        status, _, state = self.request('/api/admin/cooldown', {'enabled': True}, cookie)
        self.assertEqual((status, state['bypassCooldown']), (200, True))
        for _ in range(3):
            status, _, report = self.post_photo({**UNION, 'photo': PHOTO}, cookie)
            self.assertEqual(status, 201)
        self.assertEqual(self.request('/api/auth/session', cookie=cookie)[2]['nextSightingAt'], 0)
        self.assertEqual(self.request('/api/camera-session', {}, knight)[0], 429)
        self.request('/api/admin/mode', {'enabled': False}, cookie)  # Off clears the override.
        self.assertEqual(self.request('/api/camera-session', {}, cookie)[0], 429)
        self.request('/api/admin/mode', {'enabled': True}, cookie)
        self.assertFalse(self.request('/api/admin/state', cookie=cookie)[2]['bypassCooldown'])

    def test_admin_points_validation_idempotency_and_leaderboard(self):
        knight, data, _ = self.signup('knight@ucf.edu')
        user_id = data['user']['id']
        cookie = self.admin_cookie()
        found = self.request('/api/admin/users?q=knight%40', cookie=cookie)[2]['users']
        self.assertEqual([u['id'] for u in found], [user_id])
        base = {'userId': user_id, 'reason': 'Contest prize', 'requestId': 'req-00000001', 'confirm': True}
        for bad in ({**base, 'amount': 5, 'confirm': False}, {**base, 'amount': 0}, {**base, 'amount': 2.5},
                    {**base, 'amount': 5000}, {**base, 'amount': True}, {**base, 'amount': 5, 'reason': 'x'},
                    {**base, 'amount': 5, 'requestId': 'bad id'}, {**base, 'amount': -1}):
            self.assertEqual(self.request('/api/admin/points', bad, cookie)[0], 400, bad)
        self.assertEqual(self.request('/api/admin/points', {**base, 'amount': 5, 'userId': 'nobody'}, cookie)[0], 404)
        status, _, result = self.request('/api/admin/points', {**base, 'amount': 5}, cookie)
        self.assertEqual((status, result['score'], result['duplicate']), (200, 5, False))
        status, _, again = self.request('/api/admin/points', {**base, 'amount': 5}, cookie)  # Double click / retry.
        self.assertEqual((status, again['score'], again['duplicate']), (200, 5, True))
        status, _, result = self.request('/api/admin/points', {**base, 'amount': -2, 'requestId': 'req-00000002'}, cookie)
        self.assertEqual(result['score'], 3)
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'][0], {'id': user_id, 'displayName': 'A Knight', 'score': 3})
        self.assertEqual(self.request('/api/auth/session', cookie=knight)[2]['user']['score'], 3)
        log = self.request('/api/admin/log', cookie=cookie)[2]['entries']
        self.assertEqual([e['action'] for e in log if e['action'] == 'points'], ['points', 'points'])
        self.assertEqual(log[0]['adminEmail'], ADMIN)
        self.assertEqual((log[0]['detail']['before'], log[0]['detail']['after']), (5, 3))

    def test_admin_test_events_are_private_editable_and_deletable(self):
        cookie = self.admin_cookie()
        now = int(time.time())
        body = {'title': 'Fake pep rally', 'description': 'Testing', 'startsAt': now + 600, **UNION}
        for bad in ({**body, 'title': 'x'}, {**body, 'lat': 0, 'long': 0}, {**body, 'startsAt': '9am'},
                    {**body, 'endsAt': now}, {**body, 'startsAt': now + 90 * 86400}):
            self.assertEqual(self.request('/api/admin/test-events', bad, cookie)[0], 400, bad)
        status, _, created = self.request('/api/admin/test-events', body, cookie)
        self.assertEqual(status, 200)
        event = created['event']
        self.assertTrue(event['isTest'])
        self.assertIn('Student Union', event['location'])
        self.assertEqual(self.request('/api/events')[2]['events'], [])  # Never in the public feed.
        status, _, edited = self.request('/api/admin/test-events', {**body, 'eventId': event['eventId'], 'title': 'Renamed test'}, cookie)
        self.assertEqual(edited['event']['title'], 'Renamed test')
        self.assertEqual(len(self.request('/api/admin/test-events', cookie=cookie)[2]['events']), 1)
        self.assertEqual(self.request('/api/admin/test-events/delete', {'eventId': event['eventId']}, cookie)[0], 400)
        self.assertEqual(self.request('/api/admin/test-events/delete', {'eventId': event['eventId'], 'confirm': True}, cookie)[0], 200)
        self.assertEqual(self.request('/api/admin/test-events', cookie=cookie)[2]['events'], [])

    def test_admin_test_sightings_stay_private_and_clear_removes_test_data(self):
        cookie = self.admin_cookie()
        status, _, created = self.request('/api/admin/test-sightings', {**UNION, 'caption': 'Test pin'}, cookie)
        self.assertEqual((status, created['sighting']['status']), (200, 'test'))
        self.assertEqual(self.request('/api/sightings')[2]['sightings'], [])
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'], [])
        self.assertEqual(len(self.request('/api/admin/test-sightings', cookie=cookie)[2]['sightings']), 1)
        self.request('/api/admin/test-events', {'title': 'Fake event', 'startsAt': int(time.time()) + 60, **UNION}, cookie)
        self.request('/api/admin/test-sightings', UNION, cookie)
        self.assertEqual(self.request('/api/admin/test-data/clear', {}, cookie)[0], 400)
        status, _, cleared = self.request('/api/admin/test-data/clear', {'confirm': True}, cookie)
        self.assertEqual((cleared['testEvents'], cleared['testSightings']), (1, 2))
        self.assertEqual(self.request('/api/admin/test-sightings', cookie=cookie)[2]['sightings'], [])
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM sightings WHERE status='test'").fetchone()[0], 0)

    def test_admin_removes_invalid_real_sighting_and_points(self):
        knight, _, _ = self.signup('knight@ucf.edu')
        _, _, report = self.post_photo({**UNION, 'photo': PHOTO}, knight)
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'][0]['score'], 1)
        cookie = self.admin_cookie()
        listed = self.request('/api/admin/sightings', cookie=cookie)[2]['sightings']
        self.assertEqual(listed[0]['displayName'], 'A Knight')
        body = {'sightingId': report['sightingId'], 'reason': 'Not Knightro'}
        self.assertEqual(self.request('/api/admin/sightings/remove', body, cookie)[0], 400)
        status, _, result = self.request('/api/admin/sightings/remove', {**body, 'confirm': True}, cookie)
        self.assertEqual((status, result['status']), (200, 'rejected'))
        self.assertEqual(self.request('/api/sightings')[2]['sightings'], [])
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'], [])
        self.assertEqual(self.request('/api/photos/' + report['sightingId'])[0], 404)
        entry = self.request('/api/admin/log', cookie=cookie)[2]['entries'][0]
        self.assertEqual((entry['action'], entry['detail']['reason']), ('sighting-remove', 'Not Knightro'))


def load_tests(loader, tests, pattern):
    # Only the admin tests: the AppTests fixture is reused, its own tests run in test_server.py.
    return unittest.TestSuite(AdminTests(n) for n in vars(AdminTests) if n.startswith('test_'))


if __name__ == '__main__':
    unittest.main()
