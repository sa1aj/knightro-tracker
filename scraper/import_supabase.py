"""Import an existing completed scraper database into Supabase. Does not scrape."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from export_events import to_dt


def snapshot(database):
    if not database.is_file():
        raise ValueError('Scraper database was not found.')
    # Read-only transaction: the run metadata and rows come from one consistent snapshot.
    with sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        db.execute('BEGIN')
        latest=db.execute('SELECT status,finished_at FROM scrape_runs ORDER BY started_at DESC LIMIT 1').fetchone()
        if not latest or latest['status']!='complete' or not latest['finished_at']:
            raise ValueError('The latest scraper run must be complete. Failed and limited runs cannot replace the live feed.')
        generated=int(to_dt(latest['finished_at']).timestamp())
        rows=db.execute("SELECT * FROM events WHERE is_listed=1 AND COALESCE(status,'') NOT IN ('CANCELLED','CANCELED') ORDER BY event_id").fetchall()
        events=[]
        for row in rows:
            hosts=json.loads(row['hosts']) if isinstance(row['hosts'],str) else row['hosts']
            events.append({'eventId':str(row['event_id']),'title':row['name'],'description':row['description'] or '',
                'startsAt':int(to_dt(row['starts_at']).timestamp()),'endsAt':int(to_dt(row['ends_at']).timestamp()),
                'location':row['location'] or '', 'lat':row['latitude'],'long':row['longitude'],
                'hosts':hosts or [],'url':row['source_url']})
        return {'events':events,'available':True,'complete':True,'generatedAt':generated}


def publish_snapshot(payload,url,token):
    parsed=urlsplit(url)
    if parsed.scheme!='https' or not parsed.hostname or not parsed.hostname.endswith('.supabase.co') or parsed.username or parsed.password or parsed.port not in (None,443) or parsed.path!='' or parsed.query or parsed.fragment:
        raise ValueError('SUPABASE_URL must be the HTTPS project origin without a trailing slash.')
    if not token or len(token)<40:
        raise ValueError('Set KNIGHTRO_IMPORT_TOKEN in your local environment.')
    data=json.dumps(payload,separators=(',',':'),allow_nan=False).encode('utf-8')
    if len(data)>8000000:
        raise ValueError('The scraper snapshot exceeds the 8 MB import limit.')
    req=urllib.request.Request(url+'/functions/v1/event-import',data=data,method='POST',
        headers={'Content-Type':'application/json','X-Knightro-Import-Token':token})
    try:
        with urllib.request.urlopen(req,timeout=90) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Only the app's public diagnostic is shown, never keys or request headers.
        try: detail=json.loads(error.read()).get('error','Import failed.')
        except (ValueError,UnicodeError): detail='Import failed.'
        raise ValueError(f'Supabase import returned HTTP {error.code}: {detail}') from None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,default=Path(__file__).with_name('events.db'))
    parser.add_argument('--export',type=Path,help='Write JSON for an operator to import instead of contacting Supabase.')
    args=parser.parse_args()
    try:
        payload=snapshot(args.database)
        if args.export:
            args.export.parent.mkdir(parents=True,exist_ok=True)
            args.export.write_text(json.dumps(payload,separators=(',',':'),allow_nan=False),encoding='utf-8')
            print(f"Exported {len(payload['events'])} events from the completed scraper database.")
        else:
            result=publish_snapshot(payload,os.environ.get('SUPABASE_URL',''),os.environ.get('KNIGHTRO_IMPORT_TOKEN',''))
            print('Imported:',json.dumps(result))
        return 0
    except ValueError as error:
        print(str(error),file=sys.stderr)
    except Exception as error:
        print(f'Import failed ({type(error).__name__}). The existing feed was preserved.',file=sys.stderr)
    return 1


if __name__=='__main__':
    raise SystemExit(main())
