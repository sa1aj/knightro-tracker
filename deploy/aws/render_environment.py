"""Read a Secrets Manager JSON response from stdin; write private env files."""
import argparse
import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit


def environment(secret, origin, domain, contact):
    if not isinstance(secret, dict):
        raise ValueError('Application secret must be a JSON object.')
    url = urlsplit(origin)
    if (url.scheme != 'https' or not url.hostname or url.path not in ('', '/')
            or url.query or url.fragment or url.username or url.password or url.port not in (None, 443)):
        raise ValueError('Frontend origin must be an HTTPS origin without path or credentials.')
    if not domain or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789.-' for c in domain) or '.' not in domain:
        raise ValueError('Backend domain must be a DNS hostname.')
    allowed = ('SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURITY', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD',
               'ADMIN_EMAILS', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT')
    values = {key: str(secret.get(key, '')) for key in allowed}
    for key in ('SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD'):
        if not values[key] or 'REPLACE_' in values[key] or '.example' in values[key]:
            raise ValueError(f'Configure a real {key} in Secrets Manager.')
    if 'ADMIN_EMAILS' not in secret or 'REPLACE_' in values['ADMIN_EMAILS']:
        raise ValueError('Set ADMIN_EMAILS explicitly; an empty string disables admin accounts.')
    if values['SMTP_SECURITY'] not in ('starttls', 'ssl'):
        raise ValueError('SMTP_SECURITY must be starttls or ssl.')
    if not values['SMTP_PORT'].isdigit() or not 1 <= int(values['SMTP_PORT']) <= 65535:
        raise ValueError('Configure a valid SMTP_PORT.')
    push = [bool(values[k]) for k in ('VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT')]
    if any(push) and not all(push):
        raise ValueError('Set all three VAPID values together or leave all three empty.')
    values['PUBLIC_ORIGIN'] = origin.rstrip('/')
    token = secret.get('PROXY_TOKEN', '')
    if not isinstance(token, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{40,256}', token) or 'REPLACE_' in token:
        raise ValueError('Generate a random URL-safe PROXY_TOKEN of at least 40 characters.')
    values['TRUSTED_PROXY_TOKEN'] = token
    proxy = {'BACKEND_DOMAIN': domain, 'FRONTEND_HOST': url.netloc, 'TLS_EMAIL': contact, 'PROXY_TOKEN': token}
    if not contact or '@' not in contact:
        raise ValueError('Supply a certificate contact email.')
    for value in [*values.values(), *proxy.values()]:
        if any(c in value for c in ('\n', '\r', '\0')):
            raise ValueError('Environment values cannot contain line breaks or NUL.')
    return values, proxy


def write_private(path, values):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.chmod(path, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(''.join(f'{key}={value}\n' for key, value in values.items()))
    except Exception:
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--domain', required=True)
    parser.add_argument('--contact', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    try:
        response = json.load(__import__('sys').stdin)
        secret = json.loads(response['SecretString'])
        app, proxy = environment(secret, args.origin, args.domain, args.contact)
        args.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        write_private(args.directory / 'app.env', app)
        write_private(args.directory / 'proxy.env', proxy)
    except (KeyError, ValueError, TypeError):
        raise SystemExit('Invalid or incomplete application secret/configuration. No secret values were printed.')
