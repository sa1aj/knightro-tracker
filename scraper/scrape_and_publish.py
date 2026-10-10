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
    if not os.getenv('EVENTS_BUCKET'):
        print('Scrape completed. Set EVENTS_BUCKET to publish the application feed.')
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
