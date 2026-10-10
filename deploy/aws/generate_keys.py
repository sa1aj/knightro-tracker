"""Generate private gateway and optional Web Push keys; never print key material."""
import argparse
import base64
import json
import os
import secrets
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization


def generate(contact):
    if '@' not in contact or any(c in contact for c in '\r\n\0'):
        raise ValueError('Supply a contact email.')
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    private = key.private_numbers().private_value.to_bytes(32, 'big')
    encode = lambda data: base64.urlsafe_b64encode(data).decode().rstrip('=')
    return {'PROXY_TOKEN': secrets.token_urlsafe(48), 'VAPID_PUBLIC_KEY': encode(public),
            'VAPID_PRIVATE_KEY': encode(private), 'VAPID_SUBJECT': 'mailto:' + contact}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--contact', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    values = generate(args.contact)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(values, stream, indent=2)
        stream.write('\n')
    print('Private keys saved. Transfer them into Secrets Manager; never commit this file.')
