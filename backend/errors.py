"""Shared API error type (used by server.py and admin.py)."""


class APIError(Exception):
    def __init__(self, status, message, retry_after=None):
        self.status, self.message, self.retry_after = status, message, retry_after
