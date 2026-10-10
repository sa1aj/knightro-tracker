"""Create a consistent SQLite backup, including committed WAL transactions."""
import argparse
from contextlib import closing
from pathlib import Path
import sqlite3


def backup(source, target):
    if not source.is_file():
        raise FileNotFoundError('Application database does not exist.')
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError('Backup destination already exists.')
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as original:
        with closing(sqlite3.connect(target)) as copy:
            original.backup(copy)
            if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Database integrity check failed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    backup(args.source, args.target)
