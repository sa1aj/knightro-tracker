"""Private operator review. Never expose this as an unauthenticated web route."""
import argparse
from pathlib import Path
from contextlib import closing
from game import connection, moderate

parser = argparse.ArgumentParser()
parser.add_argument('--database', required=True, type=Path)
parser.add_argument('--export', type=Path, help='Export live JPEG reports to a private directory for optional review')
parser.add_argument('--sighting')
parser.add_argument('--decision', choices=('approve', 'reject'))
args = parser.parse_args()
if args.export:
    args.export.mkdir(parents=True, exist_ok=True)
    with closing(connection(args.database)) as db:
        for row in db.execute("SELECT * FROM sightings WHERE status IN ('published','confirmed') AND photo IS NOT NULL"):
            (args.export / (row['id']+'.jpg')).write_bytes(row['photo'])
            print(row['id'], row['place_label'], 'submitted', row['timestamp'], 'eligible points', row['candidate_points'])
elif args.sighting and args.decision:
    print(moderate(args.database, args.sighting, args.decision == 'approve'))
else:
    parser.error('Use --export or --sighting with --decision')
