"""Read-only checks for the frontend/application integration; no signup or sightings."""
import argparse
import json
from urllib.request import Request, urlopen
from urllib.parse import urlsplit


def check(site, allow_development=False):
    url = urlsplit(site)
    origin = f'{url.scheme}://{url.netloc}'
    checks = {
        '/api/auth/session': lambda data: 'user' in data and (allow_development or data.get('emailDelivery') == 'smtp'),
        '/api/sightings': lambda data: isinstance(data.get('sightings'), list),
        '/api/events': lambda data: data.get('filter') == 'likely-knightro' and isinstance(data.get('events'), list),
        '/api/leaderboard': lambda data: isinstance(data.get('leaders'), list),
        '/api/game': lambda data: isinstance(data.get('bounties'), list) and isinstance(data.get('alerts'), list),
        '/api/push/config': lambda data: 'enabled' in data,
    }
    failed = False
    for path, validate in checks.items():
        try:
            with urlopen(Request(origin + path, headers={'Accept':'application/json'}), timeout=25) as response:
                data = json.load(response)
                if response.status != 200 or not validate(data):
                    raise ValueError('Unexpected API contract or email configuration')
            print('PASS', path)
            if path == '/api/push/config' and not data['enabled']:
                print('NOTE Push disabled until VAPID keys are configured.')
        except Exception as error:
            print('FAIL', path, type(error).__name__)
            failed = True
    worker = site.rstrip('/') + '/sw.js'
    try:
        with urlopen(worker, timeout=15) as response:
            if response.status != 200 or 'javascript' not in response.headers.get('Content-Type', ''):
                raise ValueError('Worker is not JavaScript')
        print('PASS service worker path')
    except Exception as error:
        print('FAIL service worker path', type(error).__name__)
        failed = True
    return not failed


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', default='https://knightro-tracker-frontend-teal.vercel.app/')
    parser.add_argument('--allow-development', action='store_true', help='For local dev-mail previews only')
    args = parser.parse_args()
    raise SystemExit(0 if check(args.site, args.allow_development) else 1)
