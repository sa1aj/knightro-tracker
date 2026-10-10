"""Integration checks use disposable databases, local mail, and loopback only."""
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from server import create_server, initialize, digest, CAMPUSES
from PIL import Image
import base64
import io
from game import moderate, tick, connection, record_open, deliver_push, validate_subscription, day_window, SECTORS, bounties
from campus import BUILDINGS, inside
from datetime import datetime
from zoneinfo import ZoneInfo
from unittest.mock import patch, MagicMock
from server import Handler, smtp_settings

image = Image.new('RGB', (320, 320), 'gold')
buffer = io.BytesIO()
image.save(buffer, format='JPEG')
PHOTO = 'data:image/jpeg;base64,' + base64.b64encode(buffer.getvalue()).decode()


class AppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='knightro-test-')
        self.root = Path(self.temp.name)
        self.db = self.root / "app.db"
        self.app = create_server(0, self.db, self.root / "events.json", dev_mail=True)
        self.port = self.app.server_address[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.app.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.app.shutdown()
        self.app.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, body=None, cookie="", origin=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Origin": origin or self.origin, "Content-Type": "application/json", "Cookie": cookie}
        conn.request("GET" if body is None else "POST", path, None if body is None else json.dumps(body), headers)
        response = conn.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), json.loads(raw) if "json" in response.getheader("Content-Type","") else raw)
        conn.close()
        return result

    def signup(self, email="knight@ucf.edu"):
        status, _, _ = self.request("/api/auth/code", {"mode":"signup","email":email,"displayName":"A Knight"})
        self.assertEqual(status,200)
        code = re.search(r"code: (\d{6})", (self.app.outbox / (digest(email) + ".txt")).read_text())[1]
        status, headers, data = self.request("/api/auth/verify", {"email":email,"code":code})
        self.assertEqual(status,200)
        self.last_cookie_header = headers["Set-Cookie"]
        return headers["Set-Cookie"].split(";")[0], data, code

    def camera_body(self, body, cookie):
        status, _, permit = self.request('/api/camera-session', {}, cookie)
        self.assertEqual(status, 200)
        return {**body, 'captureToken': permit['captureToken']}

    def post_photo(self, body, cookie):
        return self.request('/api/sightings', self.camera_body(body, cookie), cookie)

    def test_verified_session_cookie_replay_logout_and_email_privacy(self):
        cookie, data, code = self.signup()
        self.assertEqual(data["user"]["email"],"knight@ucf.edu")
        status, headers, _ = self.request("/api/auth/verify", {"email":"knight@ucf.edu","code":code})
        self.assertEqual(status,400)  # A used code cannot mint a new session.
        status, _, session = self.request("/api/auth/session", cookie=cookie)
        self.assertEqual(session["user"]["displayName"],"A Knight")
        self.assertNotIn("email", str(self.request("/api/leaderboard")[2]))
        status, headers, _ = self.request("/api/auth/logout", {}, cookie)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Lax", headers["Set-Cookie"])
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertIsNone(self.request("/api/auth/session",cookie=cookie)[2]["user"])

    def test_domains_csrf_unauthenticated_and_offcampus_rejected(self):
        for email in ("x@gmail.com","x@ucf.edu.evil.com","x@sub.ucf.edu"):
            self.assertEqual(self.request("/api/auth/code",{"mode":"signup","email":email,"displayName":"Knight"})[0],400)
        point = {"lat":28.6024,"long":-81.2001,"photo":PHOTO}
        self.assertEqual(self.request("/api/sightings",point)[0],401)
        self.assertEqual(self.request("/api/auth/code",{"email":"x@ucf.edu"},origin="https://evil.example")[0],403)
        cookie, _, _ = self.signup("knight@knights.ucf.edu")
        for point in ({"lat":0,"long":0},{"lat":True,"long":-81.2},{"lat":28.6,"long":-81.2,"caption":"x"*201}):
            self.assertEqual(self.request("/api/sightings",point,cookie)[0],400)

    def test_atomic_cooldown_leaderboard_and_all_three_campuses(self):
        cookie, _, _ = self.signup()
        point = {"lat":28.6024,"long":-81.2001,"photo":PHOTO}
        point = self.camera_body(point, cookie)
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: self.request("/api/sightings",point,cookie), range(2)))
        self.assertEqual(sorted(r[0] for r in results),[201,429])
        self.assertGreater(next(r[2]["retryAfter"] for r in results if r[0]==429),0)
        for campus in CAMPUSES[1:]:
            with closing(sqlite3.connect(self.db)) as db:
                db.execute("UPDATE users SET last_post=0")
                db.commit()
            center = campus["center"]
            status, _, result = self.post_photo({"lat":center["lat"],"long":center["lng"],"photo":PHOTO},cookie)
            self.assertEqual(status,201)
        self.assertEqual(self.request("/api/leaderboard")[2]["leaders"][0]["score"],3)
        self.assertEqual(len(self.request("/api/sightings")[2]["sightings"]),3)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE sightings SET timestamp=?", (int(time.time())-1201,))
            db.commit()
        self.assertEqual(self.request("/api/sightings")[2]["sightings"],[])

    def test_code_limits_expiration_and_rate_limit(self):
        email="knight@ucf.edu"
        body={"mode":"signup","email":email,"displayName":"Knight"}
        self.assertEqual(self.request("/api/auth/code",body)[0],200)
        self.assertEqual(self.request("/api/auth/code",body)[0],429)
        code=re.search(r"code: (\d{6})",(self.app.outbox/(digest(email)+".txt")).read_text())[1]
        wrong="000000" if code!="000000" else "111111"
        for _ in range(5):
            self.assertEqual(self.request("/api/auth/verify",{"email":email,"code":wrong})[0],400)
        self.assertEqual(self.request("/api/auth/verify",{"email":email,"code":code})[0],400)
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE challenges SET attempts=0,expires=0")
            db.commit()
        self.assertEqual(self.request("/api/auth/verify",{"email":email,"code":code})[0],400)

    def test_static_isolation_events_and_secure_cookie(self):
        self.assertEqual(self.request("/frontend/")[0],200)
        for path in ("/frontend/../backend/server.py","/frontend/%2e%2e/backend/server.py","/backend/server.py"):
            self.assertEqual(self.request(path)[0],404)
        self.assertEqual(self.request("/api/events")[2]["available"],False)
        (self.root/"events.json").write_text('{"events":[],"available":true,"generatedAt":123}')
        self.assertEqual(self.request("/api/events")[2]["generatedAt"],123)
        self.app.public_origin="https://tracker.example"
        cookie, _, _ = self.signup()
        self.assertIn("; Secure", self.last_cookie_header)
        self.assertTrue(cookie.startswith("kt_session="))
        with closing(sqlite3.connect(self.db)) as db:
            db.execute("UPDATE sessions SET expires=0")
            db.commit()
        self.assertIsNone(self.request("/api/auth/session",cookie=cookie)[2]["user"])

    def test_photo_publishes_points_recent_and_authoritative_building_immediately(self):
        cookie, _, _ = self.signup()
        building = next(b for b in BUILDINGS if b['id'] == '52')
        point = {'lat':building['lat'], 'long':building['long']}
        self.assertEqual(self.request('/api/sightings', point, cookie)[0], 400)
        self.assertEqual(self.request('/api/sightings', {**point,'photo':'data:image/jpeg;base64,ZmFrZQ=='}, cookie)[0], 400)
        status, _, report = self.post_photo({**point,'photo':PHOTO,'points':999,'buildingId':'2'}, cookie)
        self.assertEqual(status, 201)
        self.assertEqual(report['buildingId'], '52')
        self.assertIn('Student Union', report['placeLabel'])
        self.assertEqual((report['status'], report['points']), ('published', 1))
        self.assertEqual(self.request('/api/sightings')[2]['sightings'][0]['sightingId'], report['sightingId'])
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'][0]['score'], 1)
        photo_url = '/api/photos/' + report['sightingId']
        self.assertEqual(self.request(photo_url)[0], 200)
        self.assertEqual(self.request(photo_url, cookie=cookie)[0], 200)
        self.assertEqual(self.request('/api/my-reports', cookie=cookie)[2]['reports'][0]['status'], 'published')
        self.assertEqual(moderate(self.db, report['sightingId'], True), 'confirmed')
        self.assertEqual(moderate(self.db, report['sightingId'], True), 'confirmed')
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'][0]['score'], 1)
        self.assertEqual(self.request(photo_url)[0], 200)
        self.assertEqual(moderate(self.db, report['sightingId'], False), 'rejected')
        self.assertEqual(self.request('/api/sightings')[2]['sightings'], [])
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'], [])
        self.assertEqual(self.request(photo_url)[0], 404)
        self.assertEqual(self.request(photo_url, cookie=cookie)[0], 200)

    def test_daily_bounty_reward_once_then_normal_reports_still_publish(self):
        cookie, _, _ = self.signup()
        # Millican Hall is beyond the old library pin's 120m radius, within the new section.
        b = next(b for b in BUILDINGS if b['id'] == '1')
        now = int(time.time())
        with closing(connection(self.db)) as db, db:
            db.execute('INSERT INTO bounties VALUES (?,?,?,?,?,?)', ('bounty', 'main', '2', now-10, now+86400, 'library'))
        body = {'lat':b['lat'], 'long':b['long'], 'photo':PHOTO, 'timestamp':now-10000}
        status, _, report = self.post_photo(body, cookie)
        self.assertEqual((status,report['eligiblePoints'],report['bountyId']), (201,2,'bounty'))
        with closing(connection(self.db)) as db, db:
            db.execute('UPDATE users SET last_post=0')
        status, _, repeat = self.post_photo(body, cookie)
        self.assertEqual((status,repeat['points'],repeat['bountyId']), (201,1,None))
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'][0]['score'], 3)
        with closing(connection(self.db)) as db, db:
            db.execute('UPDATE bounties SET expires=0')
        with closing(connection(self.db)) as db, db:
            db.execute('UPDATE users SET last_post=0')
        status, _, expired = self.post_photo(body, cookie)
        self.assertEqual(expired['eligiblePoints'], 1)
        moderate(self.db, expired['sightingId'], False)
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'][0]['score'], 3)

    def test_events_filter_evidence_coordinates_and_upcoming_alert_dedup(self):
        now = int(time.time())
        events = [
            {'eventId':'club','title':'Chess club','location':'Student Union','startsAt':now+100,'endsAt':now+1000,'hosts':[]},
            {'eventId':'mascot','title':'Meet Knightro','location':'Student Union Room 218','startsAt':now+100,'endsAt':now+1000,'hosts':[],'lat':0,'long':0},
            {'eventId':'virtual','title':'Meet Knightro','location':'Online','startsAt':now+100,'endsAt':now+1000,'hosts':[]},
            {'eventId':'no','title':'Knightro will not attend','location':'Student Union','startsAt':now+100,'endsAt':now+1000,'hosts':[]},
        ]
        self.app.events_file.write_text(json.dumps({'events':events,'available':True,'generatedAt':now}))
        feed = self.request('/api/events')[2]['events']
        self.assertEqual([e['eventId'] for e in feed], ['mascot'])
        self.assertEqual(feed[0]['buildingId'], '52')
        for _ in range(2):
            tick(self.db,self.app.events_file,now)
        alerts = self.request('/api/game')[2]['alerts']
        self.assertEqual(len(alerts), 1)
        self.assertIn('Student Union', alerts[0]['message'])
        self.assertNotIn('lat', alerts[0])

    def test_cluster_distinct_accounts_cooldown_and_presence_expiry(self):
        b = next(b for b in BUILDINGS if b['id'] == 'memorymall')
        now = int(time.time())
        with closing(connection(self.db)) as db, db:
            for i in range(20):
                record_open(db, 'same-user', b, now)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM alerts').fetchone()[0], 0)
            for i in range(5):
                record_open(db, str(i), b, now)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM alerts').fetchone()[0], 1)
            for i in range(7):
                record_open(db, 'later'+str(i), b, now+61)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM alerts').fetchone()[0], 1)
        tick(self.db,self.app.events_file,now+601)
        with closing(connection(self.db)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM presence WHERE opened=?', (now,)).fetchone()[0], 0)

    def test_bounty_slots_concurrent_workers_restart_and_expiry(self):
        slot, end = day_window(int(datetime(2026,10,10,12,tzinfo=ZoneInfo('America/New_York')).timestamp()))
        with ThreadPoolExecutor(2) as pool:
            list(pool.map(lambda _: tick(self.db,self.app.events_file,slot),range(2)))
        with closing(connection(self.db)) as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM bounties').fetchone()[0], 2)
            initial = bounties(db,slot)
        tick(self.db,self.app.events_file,slot+20*3600)
        with closing(connection(self.db)) as db:
            self.assertEqual(bounties(db,slot+20*3600), initial)
            self.assertEqual(bounties(db,end), [])
        tick(self.db,self.app.events_file,end)
        with closing(connection(self.db)) as db:
            following = bounties(db,end)
        self.assertEqual(len(following),2)
        self.assertTrue({b['bountyId'] for b in initial}.isdisjoint(b['bountyId'] for b in following))
        for s in SECTORS:
            if s['campus'] == 'main': self.assertEqual(len(s['buildings']), 5)
            for item in s['buildings']:
                building = next(b for b in BUILDINGS if b['id'] == item['buildingId'])
                self.assertTrue(inside(building['lat'],building['long'],s['area']))
                for ring in building['polygons']:
                    self.assertTrue(all(inside(lat,lng,s['area']) for lng,lat in ring))
        self.assertEqual(end-slot, 86400)
        for date, hours in (('2026-03-08',23),('2026-11-01',25)):
            start, finish = day_window(int(datetime.fromisoformat(date).replace(tzinfo=ZoneInfo('America/New_York')).timestamp()))
            self.assertEqual(finish-start, hours*3600)

    def test_camera_window_requires_verified_owner_fresh_single_use_token(self):
        body = {'lat':28.6024,'long':-81.2001,'photo':PHOTO}
        self.assertEqual(self.request('/api/camera-session',{})[0],401)
        cookie, _, _ = self.signup()
        self.assertEqual(self.request('/api/sightings',body,cookie)[0],400)
        capture = self.camera_body(body,cookie)
        other, _, _ = self.signup('other@ucf.edu')
        self.assertEqual(self.request('/api/sightings',capture,other)[0],400)
        with closing(connection(self.db)) as db, db:
            db.execute('UPDATE camera_tokens SET expires=0')
        self.assertEqual(self.request('/api/sightings',capture,cookie)[0],400)
        capture = self.camera_body(body,cookie)
        self.assertEqual(self.request('/api/sightings',{**capture,'photo':'data:image/jpeg;base64,ZmFrZQ=='},cookie)[0],400)
        self.assertEqual(self.request('/api/sightings',capture,cookie)[0],201)
        with closing(connection(self.db)) as db, db:
            db.execute('UPDATE users SET last_post=0')
        self.assertEqual(self.request('/api/sightings',capture,cookie)[0],400)

    def test_previous_pending_reports_migrate_with_points_and_original_expiry(self):
        cookie, _, _ = self.signup()
        _, _, report = self.post_photo({'lat':28.6024,'long':-81.2001,'photo':PHOTO},cookie)
        with closing(connection(self.db)) as db, db:
            db.execute("UPDATE sightings SET status='pending',points=0")
        initialize(self.db)
        initialize(self.db)
        self.assertEqual(self.request('/api/leaderboard')[2]['leaders'][0]['score'],1)
        self.assertEqual(self.request('/api/sightings')[2]['sightings'][0]['sightingId'],report['sightingId'])
        with closing(connection(self.db)) as db, db:
            db.execute('UPDATE sightings SET timestamp=?',(int(time.time())-1201,))
        self.assertEqual(self.request('/api/sightings')[2]['sightings'],[])

    def test_push_destination_validation_and_durable_outbox_retry(self):
        subscription = {'endpoint':'https://fcm.googleapis.com/fcm/send/test', 'keys':{
            'p256dh':base64.urlsafe_b64encode(b'\x04'+b'x'*64).decode().rstrip('='),
            'auth':base64.urlsafe_b64encode(b'x'*16).decode().rstrip('=')}}
        validate_subscription(subscription)
        for endpoint in ('http://fcm.googleapis.com/test','https://127.0.0.1/test','https://fcm.googleapis.com.evil.test/','https://fcm.googleapis.com:444/test'):
            with self.assertRaises(ValueError): validate_subscription({**subscription,'endpoint':endpoint})
        b = next(b for b in BUILDINGS if b['id'] == '52')
        now = int(time.time())
        from game import add_alert
        with closing(connection(self.db)) as db, db:
            db.execute('INSERT INTO subscriptions VALUES (?,?,?,?)', (subscription['endpoint'],'test-user',json.dumps(subscription),now))
            add_alert(db,b,'Test evidence','test',now)
        fail = MagicMock(side_effect=TimeoutError())
        deliver_push(self.db,now,fail)
        sender = MagicMock()
        deliver_push(self.db,now+1,sender)
        sender.assert_not_called()
        deliver_push(self.db,now+31,sender)
        sender.assert_called_once()
        deliver_push(self.db,now+200,sender)
        sender.assert_called_once()

    def test_smtp_starttls_ssl_and_incomplete_configuration(self):
        env = {'SMTP_HOST':'email-smtp.us-east-1.amazonaws.com','SMTP_FROM':'verified@example.com','SMTP_USER':'user','SMTP_PASSWORD':'password','SMTP_SECURITY':'starttls','SMTP_PORT':'587'}
        handler = object.__new__(Handler)
        handler.server = MagicMock(dev_mail=False)
        with patch.dict('os.environ',env), patch('server.smtplib.SMTP') as transport:
            handler.send_code('knight@ucf.edu','123456')
            smtp = transport.return_value.__enter__.return_value
            smtp.starttls.assert_called_once()
            smtp.login.assert_called_once_with('user','password')
            smtp.send_message.assert_called_once()
        with patch.dict('os.environ',{**env,'SMTP_SECURITY':'ssl','SMTP_PORT':'465'}), patch('server.smtplib.SMTP_SSL') as transport:
            handler.send_code('knight@ucf.edu','123456')
            transport.assert_called_once()
            transport.return_value.__enter__.return_value.starttls.assert_not_called()
        with patch.dict('os.environ',{'SMTP_HOST':'smtp.example','SMTP_FROM':''}):
            with self.assertRaises(ValueError): smtp_settings()


if __name__ == "__main__":
    unittest.main()
