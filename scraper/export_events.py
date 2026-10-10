"""Export a completed SQLite/PostgreSQL scraper snapshot, optionally to private S3."""
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
    date = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
    return date.replace(tzinfo=timezone.utc) if date.tzinfo is None else date.astimezone(timezone.utc)


def export_events(database, output, days=14, now=None):
    if not database.is_file():
        raise FileNotFoundError(f"Scraper database not found: {database}. Run scraper.py first.")
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
    return write_events(rows, output, days, now)


def export_from_environment(output, days=14, now=None, database_url=None):
    # Import only for the PostgreSQL/cloud path; local SQLite remains standard-library only.
    from sqlalchemy import MetaData, Table, create_engine, func, select
    from sqlalchemy.engine import URL
    if database_url is not None:
        url = database_url
    elif os.getenv('DATABASE_HOST'):
        query = {'sslmode': os.getenv('DATABASE_SSLMODE', 'require')}
        if os.getenv('DATABASE_SSLROOTCERT'):
            query['sslrootcert'] = os.environ['DATABASE_SSLROOTCERT']
        url = URL.create('postgresql+psycopg', username=os.getenv('DATABASE_USER', 'eventsadmin'),
                         password=os.environ['DATABASE_PASSWORD'], host=os.environ['DATABASE_HOST'],
                         port=int(os.getenv('DATABASE_PORT', '5432')), database=os.getenv('DATABASE_NAME', 'events'), query=query)
    else:
        url = os.getenv('DATABASE_URL', 'sqlite:///events.db')
    engine = create_engine(url, pool_pre_ping=True)
    try:
        if engine.dialect.name not in ('sqlite', 'postgresql'):
            raise ValueError('Use the scraper SQLite or PostgreSQL database.')
        with engine.connect() as connection:
            table = Table('events', MetaData(), autoload_with=connection)
            rows = connection.execute(select(table).where(table.c.is_listed.is_(True),
                func.coalesce(table.c.status, '').not_in(['CANCELLED', 'CANCELED'])).order_by(table.c.starts_at)).mappings().all()
        return write_events(rows, output, days, now)
    finally:
        engine.dispose()


def write_events(rows, output, days=14, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = now + timedelta(days=days)
    events = []
    for row in rows:
        start, end = to_dt(row["starts_at"]), to_dt(row["ends_at"])
        if end <= now or start > cutoff:
            continue
        lat, lng = row["latitude"], row["longitude"]
        if not all(type(n) in (int, float) and math.isfinite(n) for n in (lat, lng)):
            lat = lng = None
        hosts = row['hosts']
        if isinstance(hosts, str):
            hosts = json.loads(hosts or '[]')
        events.append({
            "eventId": str(row["event_id"]), "title": row["name"],
            "description": row['description'] if 'description' in row.keys() else '',
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


def publish(output, bucket):
    import boto3
    boto3.client('s3').put_object(Bucket=bucket, Key='events/events.json',
        Body=output.read_bytes(), ContentType='application/json', ServerSideEncryption='AES256')


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, default=Path(__file__).parent / "events.db")
    parser.add_argument("--output", type=Path, default=ROOT / "frontend/data/events.json")
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument('--from-env', action='store_true', help='Read PostgreSQL/SQLite credentials from the scraper environment')
    parser.add_argument('--bucket', default=os.getenv('EVENTS_BUCKET'), help='Optional private S3 feed bucket; uses the AWS role, not static credentials')
    args = parser.parse_args()
    if not 1 <= args.days <= 365:
        parser.error("--days must be between 1 and 365")
    try:
        payload = export_from_environment(args.output, args.days) if args.from_env else export_events(args.database, args.output, args.days)
        if args.bucket:
            publish(args.output, args.bucket)
    except Exception as error:
        # Database exceptions can contain passwords; never print URLs or raw exceptions.
        raise SystemExit(f'Event export failed ({type(error).__name__}). Check database, task role, and feed bucket configuration.') from None
    print(f"Wrote {len(payload['events'])} events to {args.output}")
