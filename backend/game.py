"""Durable bounties, coarse presence, and an opt-in Web Push outbox.

Run ticks in a background worker, not an HTTP request. SQLite transactions
serialize slot generation and alert cooldowns on a single deployed instance.
"""
import base64
import json
import os
import secrets
import sqlite3
import time
from contextlib import closing
from urllib.parse import urlsplit
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from campus import BUILDINGS, inside, read_events

CAMPUS_TIME = ZoneInfo('America/New_York')
BUILDING_INDEX = {b['id']: b for b in BUILDINGS}


def day_window(now):
    """A whole campus calendar day, including daylight-saving changes."""
    start = datetime.fromtimestamp(now, CAMPUS_TIME).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp()), int((start + timedelta(days=1)).timestamp())


def section(key, name, anchor, ids):
    """Curated neighboring buildings; a padded hull includes their footprints and connecting paths."""
    buildings = [BUILDING_INDEX[i] for i in ids]
    points = sorted({tuple(p) for b in buildings for ring in b['polygons'] for p in ring}
                    | {(b['long'], b['lat']) for b in buildings})
    # Hull of the expanded points (a rectangular Minkowski sum) guarantees that
    # every original footprint remains inside the same boundary used for rewards.
    points = sorted({(x+dx,y+dy) for x,y in points
                     for dx in (-0.00026,0.00026) for dy in (-0.000225,0.000225)})
    def cross(o, a, b):
        return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0])
    def half(values):
        hull = []
        for p in values:
            while len(hull) >= 2 and cross(hull[-2], hull[-1], p) <= 0:
                hull.pop()
            hull.append(p)
        return hull[:-1]
    hull = half(points) + half(list(reversed(points)))
    lng = sum(p[0] for p in hull) / len(hull)
    lat = sum(p[1] for p in hull) / len(hull)
    area = [[round(x,6),round(y,6)] for x,y in hull]
    b = BUILDING_INDEX[anchor]
    return {'sectorId': key, 'sectorName': name, 'campus': b['campus'], 'buildingId': anchor,
            'buildingName': b['name'], 'lat': lat, 'long': lng, 'area': area,
            'buildings': [{'buildingId': item['id'], 'name': item['name']} for item in buildings]}


SECTORS = [
    section('union', 'Student Union section', '52', ['52', '54', '29', '13', '45']),
    section('library', 'Library & Reflection Pond section', '2', ['2', '12', '14', '26', '1']),
    section('memory', 'Memory Mall section', 'memorymall', ['99', '98', '90', '140', '126']),
    section('arena', 'Arena & Knights Plaza section', '50', ['50', '50b', '132', '129', '137']),
    section('downtown', 'Downtown academic section', 'dr-phillips-academic-commons',
            ['dr-phillips-academic-commons', '906']),
]
SECTOR_INDEX = {s['sectorId']: s for s in SECTORS}


def migrate(db):
    columns = {r[1] for r in db.execute('PRAGMA table_info(sightings)')}
    for name, sql in {
        'building_id': 'TEXT', 'place_label': "TEXT NOT NULL DEFAULT ''",
        'photo': 'BLOB', 'status': "TEXT NOT NULL DEFAULT 'legacy'",
        'points': 'INTEGER NOT NULL DEFAULT 1', 'bounty_id': 'TEXT',
        'candidate_points': 'INTEGER NOT NULL DEFAULT 1',
    }.items():
        if name not in columns:
            db.execute(f'ALTER TABLE sightings ADD COLUMN {name} {sql}')
    db.executescript('''
        CREATE TABLE IF NOT EXISTS bounties (
            id TEXT PRIMARY KEY, campus TEXT NOT NULL, building_id TEXT NOT NULL,
            starts INTEGER NOT NULL, expires INTEGER NOT NULL,
            UNIQUE(campus, starts)
        );
        CREATE TABLE IF NOT EXISTS presence (
            user_id TEXT PRIMARY KEY, building_id TEXT NOT NULL, opened INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alerts (
            id TEXT PRIMARY KEY, building_id TEXT NOT NULL, campus TEXT NOT NULL,
            message TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
            source TEXT UNIQUE NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscriptions (
            endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL, updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_jobs (
            alert_id TEXT NOT NULL, endpoint TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            next_try INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(alert_id, endpoint)
        );
    ''')
    if 'sector_id' not in {r[1] for r in db.execute('PRAGMA table_info(bounties)')}:
        db.execute('ALTER TABLE bounties ADD COLUMN sector_id TEXT')
        # Old short drops are retired. A midnight drop can occupy today's unique slot;
        # convert that one to the new daily section while preserving any awarded claims.
        now = int(time.time())
        start, end = day_window(now)
        for s in SECTORS:
            db.execute('UPDATE bounties SET sector_id=? WHERE building_id=?', (s['sectorId'], s['buildingId']))
        db.execute('UPDATE bounties SET expires=MIN(expires,?) WHERE starts<>?', (now, start))
        db.execute('UPDATE bounties SET expires=? WHERE starts=? AND sector_id IS NOT NULL', (end, start))
    # Earlier versions left every validated photo in a private queue. Publish those
    # existing reports with their locked reward; their original 20-minute lifetime remains.
    db.execute("UPDATE sightings SET status='published',points=candidate_points WHERE status='pending' AND photo IS NOT NULL")


def connection(path):
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def add_alert(db, b, reason, source, now):
    # Campus-wide alerts use only the sector name, never a user's coordinates.
    if db.execute('SELECT 1 FROM alerts WHERE source=?', (source,)).fetchone():
        return
    if db.execute('SELECT 1 FROM alerts WHERE created>? OR (building_id=? AND created>?)',
                  (now-900, b['id'], now-3600)).fetchone():
        return
    aid = secrets.token_hex(16)
    message = f"My Knight-Sense is tingling near {b['name']}..."
    db.execute('INSERT INTO alerts VALUES (?,?,?,?,?,?,?,?)',
               (aid, b['id'], b['campus'], message, reason, now, now+900, source))
    db.execute('INSERT OR IGNORE INTO push_jobs(alert_id,endpoint) SELECT ?,endpoint FROM subscriptions', (aid,))


def tick(path, events_file, now=None):
    now = int(time.time()) if now is None else now
    feed = read_events(events_file, now)
    with closing(connection(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        start, end = day_window(now)
        for campus in sorted({s['campus'] for s in SECTORS}):
            s = secrets.choice([s for s in SECTORS if s['campus'] == campus])
            db.execute('INSERT OR IGNORE INTO bounties(id,campus,building_id,starts,expires,sector_id) VALUES (?,?,?,?,?,?)',
                       (secrets.token_hex(16), campus, s['buildingId'], start, end, s['sectorId']))
        for e in feed['events']:
            if now <= e['startsAt'] <= now+900:
                b = next(b for b in BUILDINGS if b['id'] == e['buildingId'])
                add_alert(db, b, e['reason'], 'event:'+str(e['eventId'])+':'+str(e['startsAt']), now)
        db.execute('DELETE FROM presence WHERE opened<?', (now-600,))
        db.execute('DELETE FROM alerts WHERE expires<?', (now-86400,))
        db.execute('DELETE FROM push_jobs WHERE alert_id NOT IN (SELECT id FROM alerts)')
        db.execute('DELETE FROM bounties WHERE expires<? AND id NOT IN (SELECT bounty_id FROM sightings WHERE bounty_id IS NOT NULL)', (now-86400,))


def bounties(db, now):
    values = []
    for row in db.execute('SELECT * FROM bounties WHERE starts<=? AND expires>?', (now, now)):
        s = SECTOR_INDEX.get(row['sector_id'])
        if s:
            values.append({**s, 'bountyId': row['id'], 'startsAt': row['starts'],
                           'expiresAt': row['expires'], 'multiplier': 2})
    return values


def reward(db, lat, lng, now):
    for b in bounties(db, now):
        if inside(lat, lng, b['area']):
            return b['bountyId'], 2
    return None, 1


def record_open(db, user_id, building, now):
    previous = db.execute('SELECT opened FROM presence WHERE user_id=?', (user_id,)).fetchone()
    if previous and previous[0] > now-60:
        return
    # One recent opening per verified account, rather than repeated refreshes.
    db.execute('INSERT OR REPLACE INTO presence VALUES (?,?,?)', (user_id, building['id'], now))
    recent = db.execute('SELECT COUNT(*) FROM presence WHERE building_id=? AND opened>?', (building['id'], now-300)).fetchone()[0]
    baseline = db.execute('SELECT COUNT(*) FROM presence WHERE building_id=? AND opened BETWEEN ? AND ?',
                          (building['id'], now-600, now-300)).fetchone()[0]
    if recent >= 6 and baseline <= 2:
        add_alert(db, building, 'Sudden cluster of app openings; unconfirmed mascot activity',
                  'cluster:'+building['id']+':'+str(now//900), now)


def validate_subscription(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid push subscription.')
    url = urlsplit(value.get('endpoint', ''))
    host = (url.hostname or '').lower()
    allowed = host in ('fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com') or host.endswith('.notify.windows.com')
    if not allowed or url.scheme != 'https' or url.username or url.password or url.port not in (None, 443) or len(value['endpoint']) > 2048:
        raise ValueError('Unsupported push service.')
    keys = value.get('keys', {})
    for key, length in (('p256dh', 65), ('auth', 16)):
        encoded = keys.get(key, '')
        if not isinstance(encoded, str) or len(encoded) > 100:
            raise ValueError('Invalid push key.')
        decoded = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        if len(decoded) != length or (key == 'p256dh' and decoded[0] != 4):
            raise ValueError('Invalid push key.')
    return {'endpoint': value['endpoint'], 'keys': {k: keys[k] for k in ('p256dh', 'auth')}}


def push_enabled():
    return all(os.environ.get(k) for k in ('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'))


def deliver_push(path, now=None, sender=None):
    if sender is None:
        if not push_enabled():
            return
        from pywebpush import webpush
        sender = lambda subscription, payload: webpush(subscription_info=subscription, data=payload,
            vapid_private_key=os.environ['VAPID_PRIVATE_KEY'], vapid_claims={'sub': os.environ['VAPID_SUBJECT']},
            ttl=900, timeout=10)
    now = int(time.time()) if now is None else now
    with closing(connection(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        jobs = db.execute('''SELECT j.*,s.payload,a.message,a.expires FROM push_jobs j
            JOIN subscriptions s ON s.endpoint=j.endpoint JOIN alerts a ON a.id=j.alert_id
            WHERE j.sent=0 AND j.attempts<5 AND j.next_try<=? AND a.expires>? LIMIT 20''', (now, now)).fetchall()
        for j in jobs:
            db.execute('UPDATE push_jobs SET next_try=?,attempts=attempts+1 WHERE alert_id=? AND endpoint=?',
                       (now+120, j['alert_id'], j['endpoint']))
    for j in jobs:
        try:
            sender(json.loads(j['payload']), json.dumps({'title': 'Knight-Sense', 'body': j['message'],
                   'alertId': j['alert_id'], 'expiresAt': j['expires'], 'url': '/frontend/'}))
        except Exception as exc:
            response = getattr(exc, 'response', None)
            status = getattr(response, 'status_code', None)
            with closing(connection(path)) as db, db:
                if status in (404, 410):
                    db.execute('DELETE FROM subscriptions WHERE endpoint=?', (j['endpoint'],))
                    db.execute('DELETE FROM push_jobs WHERE endpoint=?', (j['endpoint'],))
                else:
                    db.execute('UPDATE push_jobs SET next_try=? WHERE alert_id=? AND endpoint=?',
                               (now+min(900, 30*2**j['attempts']), j['alert_id'], j['endpoint']))
        else:
            with closing(connection(path)) as db, db:
                db.execute('UPDATE push_jobs SET sent=1 WHERE alert_id=? AND endpoint=?', (j['alert_id'], j['endpoint']))


def moderate(path, sighting_id, approve):
    """Optional operator review can remove a live report and its points atomically."""
    with closing(connection(path)) as db, db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT * FROM sightings WHERE id=?', (sighting_id,)).fetchone()
        if row is None:
            raise ValueError('Sighting not found.')
        if row['status'] == 'rejected' or (approve and row['status'] == 'confirmed'):
            return row['status']
        status = 'confirmed' if approve else 'rejected'
        db.execute('UPDATE sightings SET status=?,points=? WHERE id=?',
                   (status, row['candidate_points'] if approve else 0, sighting_id))
        return status
