"""Admin mode for explicitly authorized, email-verified accounts.

Authorization never comes from the client. Every request re-checks:
  1. a valid session cookie for a verified account (server.Handler.user),
  2. that account's email is on the server-side allowlist (ADMIN_EMAILS), and
  3. for tools, that the admin has Admin Mode switched on (stored server-side).
Turning Admin Mode off also switches off that admin's cooldown bypass.

Test events and test sightings live apart from public data: test sightings use
status 'test' (never returned by public routes or counted on the leaderboard),
and test events sit in their own table that only admin routes read.
"""
import json
import math
import os
import re
import secrets
import time

from campus import CAMPUSES, place
from errors import APIError

DEFAULT_ADMINS = ('jo822842@ucf.edu',)
PUBLIC_STATUSES = ('published', 'confirmed', 'legacy')
ACTIVE_SECONDS = 1200
MAX_ADJUSTMENT = 1000
REQUEST_ID_RE = re.compile(r'[A-Za-z0-9-]{8,64}')


def allowlist():
    """ADMIN_EMAILS (comma-separated) replaces the default list when set."""
    raw = os.environ.get('ADMIN_EMAILS')
    values = raw.split(',') if raw is not None else DEFAULT_ADMINS
    return {v.strip().lower() for v in values if v.strip()}


def is_admin(user):
    return user is not None and user['email'].lower() in allowlist()


def migrate(db):
    db.executescript('''
        CREATE TABLE IF NOT EXISTS admin_state (
            user_id TEXT PRIMARY KEY REFERENCES users(id),
            mode INTEGER NOT NULL DEFAULT 0, bypass INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS point_adjustments (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
            amount INTEGER NOT NULL, reason TEXT NOT NULL, admin_id TEXT NOT NULL,
            request_id TEXT UNIQUE NOT NULL, created INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS point_adjustments_user ON point_adjustments(user_id);
        CREATE TABLE IF NOT EXISTS test_events (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
            starts INTEGER NOT NULL, ends INTEGER NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
            created_by TEXT NOT NULL, created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id TEXT NOT NULL,
            action TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL
        );
    ''')


def admin_state(db, user):
    row = db.execute('SELECT mode, bypass FROM admin_state WHERE user_id=?', (user['id'],)).fetchone()
    return {'mode': bool(row and row['mode']), 'bypassCooldown': bool(row and row['mode'] and row['bypass'])}


def bypass_active(db, user):
    """Cooldown bypass applies only to an allowlisted admin with Admin Mode and bypass both on."""
    return is_admin(user) and admin_state(db, user)['bypassCooldown']


def session_info(db, user):
    """Admin fields for /api/auth/session. Omitted entirely for everyone else."""
    if not is_admin(user):
        return None
    return {'allowed': True, **admin_state(db, user)}


def user_score(db, user_id):
    sightings = db.execute(
        f"SELECT COALESCE(SUM(points),0) FROM sightings WHERE user_id=? AND status IN {PUBLIC_STATUSES}",
        (user_id,)).fetchone()[0]
    adjustments = db.execute('SELECT COALESCE(SUM(amount),0) FROM point_adjustments WHERE user_id=?',
                             (user_id,)).fetchone()[0]
    return sightings + adjustments


def leaderboard(db, limit=50):
    rows = db.execute(f'''
        SELECT u.id, u.name AS displayName,
               COALESCE(s.total, 0) + COALESCE(a.total, 0) AS score
        FROM users u
        LEFT JOIN (SELECT user_id, SUM(points) AS total FROM sightings
                   WHERE status IN {PUBLIC_STATUSES} GROUP BY user_id) s ON s.user_id = u.id
        LEFT JOIN (SELECT user_id, SUM(amount) AS total FROM point_adjustments GROUP BY user_id) a ON a.user_id = u.id
        WHERE s.total IS NOT NULL OR a.total IS NOT NULL
        ORDER BY score DESC, u.created ASC, u.id ASC LIMIT ?
    ''', (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- validation helpers
def _campus_for(lat, lng):
    return next((c for c in CAMPUSES if c['bounds']['minLat'] <= lat <= c['bounds']['maxLat']
                 and c['bounds']['minLng'] <= lng <= c['bounds']['maxLng']), None)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _location(data):
    lat, lng = data.get('lat'), data.get('long')
    if not _number(lat) or not _number(lng):
        raise APIError(400, 'Choose a valid map location.')
    campus = _campus_for(lat, lng)
    if campus is None:
        raise APIError(400, 'Choose a location on Main, Rosen, or Downtown campus.')
    return lat, lng, campus


def _text(data, key, label, low, high, required=True):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise APIError(400, f'{label} must be text.')
    value = value.strip()
    if (required or value) and not low <= len(value) <= high:
        raise APIError(400, f'{label} must be {low}–{high} characters.')
    return value


def _confirmed(data):
    if data.get('confirm') is not True:
        raise APIError(400, 'Confirm this action before it is applied.')


def _log(db, admin, action, detail, now):
    db.execute('INSERT INTO admin_log(admin_id, action, detail, created) VALUES (?,?,?,?)',
               (admin['id'], action, json.dumps(detail, separators=(',', ':')), now))


def _event_out(row):
    label = place(row['lat'], row['lng'])
    campus = _campus_for(row['lat'], row['lng'])
    return {'eventId': 'test-' + row['id'], 'title': row['title'], 'description': row['description'],
            'location': label['placeLabel'], 'startsAt': row['starts'], 'endsAt': row['ends'],
            'lat': row['lat'], 'long': row['lng'], 'campus': campus['id'] if campus else None,
            'buildingId': label['buildingId'], 'buildingName': label['buildingName'],
            'probability': 1, 'reason': 'Admin test event', 'hosts': ['Admin test'], 'url': None, 'isTest': True}


# ---------------------------------------------------------------- authorization
def require_admin(handler, db, tools=True):
    """Every admin route calls this first. tools=True also requires Admin Mode to be on."""
    user = handler.user(db, required=True)
    if not is_admin(user):
        raise APIError(403, 'Admin access is limited to authorized accounts.')
    if tools and not admin_state(db, user)['mode']:
        raise APIError(403, 'Turn on Admin Mode to use admin tools.')
    return user


# ---------------------------------------------------------------- routes
def handle_get(handler, db, path, query):
    now = int(time.time())
    if path == '/api/admin/state':
        user = require_admin(handler, db, tools=False)
        return admin_state(db, user)
    require_admin(handler, db)
    if path == '/api/admin/users':
        q = (query.get('q', [''])[0] or '').strip().lower()[:60]
        like = '%' + q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        rows = db.execute("""SELECT id, name AS displayName, email FROM users
                             WHERE lower(name) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\'
                             ORDER BY name LIMIT 20""", (like, like)).fetchall()
        return {'users': [{**dict(r), 'score': user_score(db, r['id'])} for r in rows]}
    if path == '/api/admin/test-events':
        rows = db.execute('SELECT * FROM test_events WHERE ends>? ORDER BY starts', (now,)).fetchall()
        return {'events': [_event_out(r) for r in rows]}
    if path == '/api/admin/test-sightings':
        rows = db.execute("""SELECT id AS sightingId, lat, lng AS long, caption, timestamp, campus,
                                    place_label AS placeLabel, building_id AS buildingId, status, points
                             FROM sightings WHERE status='test' AND timestamp>? ORDER BY timestamp DESC""",
                          (now - ACTIVE_SECONDS,)).fetchall()
        return {'sightings': [{**dict(r), 'photoUrl': None, 'isTest': True} for r in rows]}
    if path == '/api/admin/sightings':
        rows = db.execute("""SELECT s.id AS sightingId, s.place_label AS placeLabel, s.caption, s.timestamp,
                                    s.status, s.points, s.lat, s.lng AS long, u.name AS displayName,
                                    CASE WHEN s.photo IS NOT NULL THEN '/api/photos/' || s.id ELSE NULL END AS photoUrl
                             FROM sightings s JOIN users u ON u.id = s.user_id
                             WHERE s.timestamp>? ORDER BY s.timestamp DESC LIMIT 60""",
                          (now - 86400,)).fetchall()
        return {'sightings': [dict(r) for r in rows]}
    if path == '/api/admin/log':
        rows = db.execute("""SELECT l.id, l.action, l.detail, l.created, u.name AS adminName, u.email AS adminEmail
                             FROM admin_log l LEFT JOIN users u ON u.id = l.admin_id
                             ORDER BY l.id DESC LIMIT 50""").fetchall()
        return {'entries': [{**dict(r), 'detail': json.loads(r['detail'])} for r in rows]}
    raise APIError(404, 'Admin route not found.')


def handle_post(handler, db, path, data):
    now = int(time.time())
    db.execute('BEGIN IMMEDIATE')  # Serializes admin writes with sightings and other admins.

    if path == '/api/admin/mode':
        admin = require_admin(handler, db, tools=False)
        enabled = data.get('enabled')
        if not isinstance(enabled, bool):
            raise APIError(400, 'Choose on or off.')
        # Switching Admin Mode off also clears every testing override for this admin.
        db.execute('''INSERT INTO admin_state(user_id, mode, bypass) VALUES (?,?,0)
                      ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,
                      bypass=CASE WHEN excluded.mode=1 THEN bypass ELSE 0 END''', (admin['id'], int(enabled)))
        _log(db, admin, 'admin-mode', {'enabled': enabled}, now)
        return admin_state(db, admin)

    admin = require_admin(handler, db)

    if path == '/api/admin/cooldown':
        enabled = data.get('enabled')
        if not isinstance(enabled, bool):
            raise APIError(400, 'Choose on or off.')
        db.execute('UPDATE admin_state SET bypass=? WHERE user_id=?', (int(enabled), admin['id']))
        _log(db, admin, 'cooldown-bypass', {'enabled': enabled}, now)
        return admin_state(db, admin)

    if path == '/api/admin/points':
        _confirmed(data)
        user_id, amount, request_id = data.get('userId'), data.get('amount'), data.get('requestId')
        if type(amount) is not int or amount == 0 or abs(amount) > MAX_ADJUSTMENT:
            raise APIError(400, f'Enter a whole number between -{MAX_ADJUSTMENT} and {MAX_ADJUSTMENT}, not 0.')
        if not isinstance(request_id, str) or not REQUEST_ID_RE.fullmatch(request_id):
            raise APIError(400, 'Missing request ID. Reload and try again.')
        reason = _text(data, 'reason', 'Reason', 3, 140)
        existing = db.execute('SELECT * FROM point_adjustments WHERE request_id=?', (request_id,)).fetchone()
        if existing:  # A retried or double-clicked request is applied only once.
            if existing['admin_id'] != admin['id']:
                raise APIError(409, 'This request ID was already used.')
            return {'ok': True, 'duplicate': True, 'userId': existing['user_id'],
                    'score': user_score(db, existing['user_id'])}
        target = db.execute('SELECT id, name FROM users WHERE id=?', (user_id,)).fetchone() if isinstance(user_id, str) else None
        if target is None:
            raise APIError(404, 'User not found.')
        before = user_score(db, target['id'])
        if before + amount < 0:
            raise APIError(400, f'{target["name"]} has {before} points; a deduction cannot go below zero.')
        db.execute('INSERT INTO point_adjustments VALUES (?,?,?,?,?,?,?)',
                   (secrets.token_hex(16), target['id'], amount, reason, admin['id'], request_id, now))
        _log(db, admin, 'points', {'user': target['name'], 'userId': target['id'], 'amount': amount,
                                   'reason': reason, 'before': before, 'after': before + amount}, now)
        return {'ok': True, 'duplicate': False, 'userId': target['id'], 'score': before + amount}

    if path == '/api/admin/test-events':
        title = _text(data, 'title', 'Title', 3, 80)
        description = _text(data, 'description', 'Description', 0, 400, required=False)
        lat, lng, _ = _location(data)
        starts, ends = data.get('startsAt'), data.get('endsAt')
        if type(starts) is not int:
            raise APIError(400, 'Choose a start date and time.')
        if ends is None:
            ends = starts + 3600
        if type(ends) is not int or not starts < ends <= starts + 2 * 86400:
            raise APIError(400, 'End time must be after the start and within 48 hours.')
        if not now - 86400 <= starts <= now + 60 * 86400:
            raise APIError(400, 'Test events must start between yesterday and 60 days from now.')
        event_id = data.get('eventId')
        if event_id is not None:  # Edit
            if not isinstance(event_id, str) or not event_id.startswith('test-'):
                raise APIError(404, 'Test event not found.')
            raw_id = event_id.removeprefix('test-')
            if not db.execute('SELECT 1 FROM test_events WHERE id=?', (raw_id,)).fetchone():
                raise APIError(404, 'Test event not found.')
            db.execute('UPDATE test_events SET title=?,description=?,starts=?,ends=?,lat=?,lng=? WHERE id=?',
                       (title, description, starts, ends, lat, lng, raw_id))
            _log(db, admin, 'test-event-edit', {'eventId': event_id, 'title': title}, now)
        else:  # Create
            raw_id = secrets.token_hex(12)
            db.execute('INSERT INTO test_events VALUES (?,?,?,?,?,?,?,?,?)',
                       (raw_id, title, description, starts, ends, lat, lng, admin['id'], now))
            _log(db, admin, 'test-event-create', {'eventId': 'test-' + raw_id, 'title': title}, now)
        row = db.execute('SELECT * FROM test_events WHERE id=?', (raw_id,)).fetchone()
        return {'ok': True, 'event': _event_out(row)}

    if path == '/api/admin/test-events/delete':
        _confirmed(data)
        event_id = data.get('eventId')
        raw_id = event_id.removeprefix('test-') if isinstance(event_id, str) else None
        row = db.execute('SELECT title FROM test_events WHERE id=?', (raw_id,)).fetchone() if raw_id else None
        if row is None:
            raise APIError(404, 'Test event not found.')
        db.execute('DELETE FROM test_events WHERE id=?', (raw_id,))
        _log(db, admin, 'test-event-delete', {'eventId': event_id, 'title': row['title']}, now)
        return {'ok': True}

    if path == '/api/admin/test-sightings':
        lat, lng, campus = _location(data)
        caption = _text(data, 'caption', 'Caption', 0, 200, required=False)
        label = place(lat, lng)
        sid = secrets.token_hex(16)
        # status 'test': never public, never on the leaderboard, zero points.
        db.execute('''INSERT INTO sightings(id,user_id,lat,lng,caption,timestamp,campus,building_id,place_label,
                      photo,status,points,bounty_id,candidate_points) VALUES (?,?,?,?,?,?,?,?,?,NULL,'test',0,NULL,0)''',
                   (sid, admin['id'], lat, lng, caption, now, campus['id'], label['buildingId'], label['placeLabel']))
        _log(db, admin, 'test-sighting-create', {'sightingId': sid, 'place': label['placeLabel']}, now)
        return {'ok': True, 'sighting': {'sightingId': sid, 'lat': lat, 'long': lng, 'caption': caption,
                                         'timestamp': now, 'campus': campus['id'], 'status': 'test', 'points': 0,
                                         'photoUrl': None, 'isTest': True, **label}}

    if path == '/api/admin/sightings/remove':
        _confirmed(data)
        sid = data.get('sightingId')
        reason = _text(data, 'reason', 'Reason', 3, 140)
        row = db.execute('SELECT s.*, u.name FROM sightings s JOIN users u ON u.id=s.user_id WHERE s.id=?',
                         (sid,)).fetchone() if isinstance(sid, str) else None
        if row is None:
            raise APIError(404, 'Sighting not found.')
        if row['status'] == 'test':
            db.execute('DELETE FROM sightings WHERE id=?', (sid,))
            result = 'deleted'
        elif row['status'] == 'rejected':
            return {'ok': True, 'status': 'rejected', 'unchanged': True}
        else:
            # Same effect as moderate.py --decision reject: off the map, points removed, photo owner-only.
            db.execute("UPDATE sightings SET status='rejected', points=0 WHERE id=?", (sid,))
            result = 'rejected'
        _log(db, admin, 'sighting-remove', {'sightingId': sid, 'reporter': row['name'], 'place': row['place_label'],
                                            'previousStatus': row['status'], 'points': row['points'],
                                            'result': result, 'reason': reason}, now)
        return {'ok': True, 'status': result}

    if path == '/api/admin/test-data/clear':
        _confirmed(data)
        events = db.execute('DELETE FROM test_events').rowcount
        sightings = db.execute("DELETE FROM sightings WHERE status='test'").rowcount
        _log(db, admin, 'test-data-clear', {'testEvents': events, 'testSightings': sightings}, now)
        return {'ok': True, 'testEvents': events, 'testSightings': sightings}

    raise APIError(404, 'Admin route not found.')
