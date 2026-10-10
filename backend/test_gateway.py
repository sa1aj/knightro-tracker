import ipaddress
from email.message import Message
from types import SimpleNamespace
import unittest
from server import Handler


class GatewayTests(unittest.TestCase):
    def address(self, token, client, expected='test-shared-token'):
        handler = object.__new__(Handler)
        handler.server = SimpleNamespace(trusted_proxy_token=expected)
        handler.client_address = ('127.0.0.1', 1234)
        handler.headers = Message()
        handler.headers['X-Knightro-Proxy-Token'] = token
        handler.headers['X-Knightro-Client-IP'] = client
        return handler.request_ip()

    def test_forwarded_client_address_requires_the_private_gateway_token(self):
        self.assertEqual(self.address('test-shared-token', '203.0.113.7'), '203.0.113.7')
        self.assertEqual(self.address('test-shared-token', '2001:db8::7'), '2001:db8::7')
        for token, address in [('', '203.0.113.7'), ('forged', '203.0.113.7'), ('😈', '203.0.113.7'),
                               ('test-shared-token', 'spoofed,127.0.0.1'), ('test-shared-token', '')]:
            self.assertEqual(self.address(token, address), '127.0.0.1')
        self.assertEqual(self.address('test-shared-token', '203.0.113.7', expected=''), '127.0.0.1')
