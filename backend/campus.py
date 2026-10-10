"""Shared, deterministic campus labels and conservative mascot-event hints."""
import json
import math
from pathlib import Path
import re

DATA = Path(__file__).resolve().parents[1] / 'frontend/data'
BUILDINGS = json.loads((DATA / 'buildings.json').read_text(encoding='utf-8'))['buildings']
CAMPUSES = json.loads((DATA / 'campuses.json').read_text(encoding='utf-8'))


def distance(lat, lng, b):
    return math.hypot((lat-b['lat'])*111320, (lng-b['long'])*111320*math.cos(math.radians(lat)))


def inside(lat, lng, ring):
    result = False
    for a, b in zip(ring, ring[-1:] + ring[:-1]):
        if (a[1] > lat) != (b[1] > lat) and lng < (b[0]-a[0])*(lat-a[1])/(b[1]-a[1])+a[0]:
            result = not result
    return result


def building_at(lat, lng):
    containing = [b for b in BUILDINGS if any(inside(lat, lng, ring) for ring in b['polygons'])]
    if containing:
        return min(containing, key=lambda b: distance(lat, lng, b)), 'At'
    nearest = min(BUILDINGS, key=lambda b: distance(lat, lng, b), default=None)
    return (nearest, 'Near') if nearest and distance(lat, lng, nearest) <= 120 else (None, '')


def place(lat, lng):
    b, relation = building_at(lat, lng)
    if b:
        return {'buildingId': b['id'], 'buildingName': b['name'], 'placeLabel': f"{relation} {b['name']}"}
    campus = next((c for c in CAMPUSES if c['bounds']['minLat'] <= lat <= c['bounds']['maxLat']
                   and c['bounds']['minLng'] <= lng <= c['bounds']['maxLng']), None)
    return {'buildingId': None, 'buildingName': None, 'placeLabel': campus['name'] if campus else 'On campus'}


def normalize(value):
    return re.sub(r'[^a-z0-9]+', ' ', str(value).lower()).strip()


def event_hint(event):
    """Evidence, not an assertion that Knightro is present. Never trust feed probability fields."""
    title = normalize(event.get('title', ''))
    text = normalize(str(event.get('title', '')) + ' ' + str(event.get('description', '')))
    host_list = event.get('hosts', [])
    hosts = normalize(' '.join(str(h) for h in host_list)) if isinstance(host_list, list) else ''
    if re.search(r'\bknightro\b', text):
        # Negated/cancelled appearances should not produce a hint.
        if re.search(r'\b(no|without|not|cancelled|canceled)\b.{0,35}\bknightro\b|\bknightro\b.{0,35}\b(not attending|cancelled|canceled|will not)\b', text):
            return None
        probability, reason = .95, 'Event listing mentions Knightro'
    elif re.search(r'\b(pep rally|homecoming kickoff|homecoming parade|spirit splash)\b', title):
        probability, reason = .85, 'Campus spirit event; mascot attendance is possible'
    elif 'ucf athletics' in hosts and re.search(r'\b(football|basketball|volleyball)\b.*\b(vs|versus|home game)\b', title):
        probability, reason = .8, 'UCF Athletics home event; mascot attendance is possible'
    else:
        return None
    location = normalize(event.get('location', ''))
    b = next((b for b in BUILDINGS if any(re.search(r'\b'+re.escape(normalize(name))+r'\b', location)
               for name in [b['name']] + [a for a in b['aliases'] if len(a) >= 3])), None)
    if b is None:
        lat, lng = event.get('lat'), event.get('long')
        if any(type(n) not in (int, float) or not math.isfinite(n) for n in (lat, lng)):
            return None
        b, _ = building_at(lat, lng)
    if b is None:
        return None
    return {**event, 'lat': b['lat'], 'long': b['long'], 'buildingId': b['id'],
            'buildingName': b['name'], 'campus': b['campus'], 'probability': probability, 'reason': reason}


def read_events(path, now):
    if not path.exists():
        return {'events': [], 'available': False, 'generatedAt': None}
    feed = json.loads(path.read_text(encoding='utf-8'))
    hints = []
    for e in feed.get('events', []):
        if (not isinstance(e, dict) or not e.get('eventId') or not isinstance(e.get('title'), str)
                or any(type(e.get(k)) not in (int, float) or not math.isfinite(e[k]) for k in ('startsAt', 'endsAt'))
                or e['endsAt'] <= now or e['endsAt'] < e['startsAt']):
            continue
        hint = event_hint(e)
        if hint:
            hints.append(hint)
    return {**feed, 'events': hints, 'filter': 'likely-knightro'}
