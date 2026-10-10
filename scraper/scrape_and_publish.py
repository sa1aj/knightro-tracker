"""Publish a feed only after a successful, complete scraper run."""
import os
import argparse
from pathlib import Path
import subprocess
import sys
from export_events import export_from_environment, publish


def main():
    script = Path(__file__).with_name('scraper.py')
    result = subprocess.run([sys.executable, str(script), *sys.argv[1:]])
    if result.returncode:
        return result.returncode
    if any(arg == '--limit' or arg.startswith('--limit=') for arg in sys.argv[1:]):
        print('Limited scraper check completed; production feed was not replaced.')
        return 0
    if os.getenv('SUPABASE_URL'):
        # Manual run only: scrape once, then import that completed database. No scheduler is added.
        url = os.getenv('DATABASE_URL', 'sqlite:///events.db')
        options = argparse.ArgumentParser(add_help=False)
        options.add_argument('--database-url')
        args, _ = options.parse_known_args(sys.argv[1:])
        url = args.database_url or url
        if not url.startswith('sqlite:///') or os.getenv('DATABASE_HOST'):
            print('For the Supabase importer, use a SQLite scraper database and import_supabase.py.', file=sys.stderr)
            return 1
        script = Path(__file__).with_name('import_supabase.py')
        return subprocess.run([sys.executable, str(script), '--database', url.removeprefix('sqlite:///')]).returncode
    if not os.getenv('EVENTS_BUCKET'):
        print('Scrape completed. Run import_supabase.py to import this database into Supabase.')
        return 0
    try:
        output = Path(os.getenv('EVENTS_OUTPUT', '/data/events.json'))
        options = argparse.ArgumentParser(add_help=False)
        options.add_argument('--database-url')
        args, _ = options.parse_known_args(sys.argv[1:])
        data = export_from_environment(output, database_url=args.database_url)
        publish(output, os.environ['EVENTS_BUCKET'])
        print(f"Published {len(data['events'])} events to the private application feed.")
        return 0
    except Exception as error:
        print(f'Feed publication failed ({type(error).__name__}); the previous S3 feed is unchanged.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
