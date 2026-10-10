"""Export a completed SQLite scraper snapshot for the application server."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import sqlite3
import tempfile
import os

ROOT = Path(__file__).resolve().parents[1]


def to_dt(value):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return date.replace(tzinfo=timezone.utc) if date.tzinfo is None else date.astimezone(timezone.utc)


def export_events(database, output, days=14, now=None):
    if not database.is_file():
        raise FileNotFoundError(f"Scraper database not found: {database}. Run scraper.py first.")
    now = now or datetime.now(timezone.utc)
    cutoff = now + timedelta(days=days)
    conn = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        columns = {row[1] for row in conn.execute('PRAGMA table_info(events)')}
        description = 'description' if 'description' in columns else "'' AS description"
        rows = conn.execute("""
            SELECT event_id,name,starts_at,ends_at,location,latitude,longitude,hosts,source_url,
        """ + description + """
            FROM events WHERE is_listed=1 AND COALESCE(status,'') NOT IN ('CANCELLED','CANCELED')
            ORDER BY starts_at
        """).fetchall()
    finally:
        conn.close()
    events = []
    for row in rows:
        start, end = to_dt(row["starts_at"]), to_dt(row["ends_at"])
        if end <= now or start > cutoff:
            continue
        lat, lng = row["latitude"], row["longitude"]
        if not all(type(n) in (int, float) and math.isfinite(n) for n in (lat, lng)):
            lat = lng = None
        hosts = json.loads(row["hosts"] or "[]")
        events.append({
            "eventId": str(row["event_id"]), "title": row["name"],
            "description": row['description'],
            "startsAt": int(start.timestamp()), "endsAt": int(end.timestamp()),
            "location": row["location"], "lat": lat, "long": lng,
            "hosts": hosts if isinstance(hosts, list) else [], "url": row["source_url"],
        })
    output.parent.mkdir(parents=True, exist_ok=True)
    payload = {"events": events, "generatedAt": int(now.timestamp()), "available": True}
    # Readers get either the old complete feed or the new complete feed.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False, suffix=".tmp") as tmp:
        json.dump(payload, tmp, indent=2, allow_nan=False)
        temp_path = Path(tmp.name)
    try:
        os.replace(temp_path, output)
    finally:
        temp_path.unlink(missing_ok=True)
    return payload


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, default=Path(__file__).parent / "events.db")
    parser.add_argument("--output", type=Path, default=ROOT / "frontend/data/events.json")
    parser.add_argument("--days", type=int, default=14)
    args = parser.parse_args()
    if not 1 <= args.days <= 365:
        parser.error("--days must be between 1 and 365")
    payload = export_events(args.database, args.output, args.days)
    print(f"Wrote {len(payload['events'])} events to {args.output}")
