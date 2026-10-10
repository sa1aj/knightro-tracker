"""Scrape public KnightConnect event listings and their linked calendar files."""
import argparse
import logging
import os
import re
import time
from datetime import date, datetime, time as daytime, timezone
from urllib.robotparser import RobotFileParser
from zoneinfo import ZoneInfo

import requests
from icalendar import Calendar
from playwright.sync_api import sync_playwright
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from sqlalchemy import (Boolean, Column, DateTime, Float, Integer, JSON, MetaData, String,
                        Table, Text, create_engine, text, update)
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import URL

BASE = "https://knightconnect.campuslabs.com"
LISTING = BASE + "/engage/events"
AGENT = "KnightConnectEvents/1.0"
LOG = logging.getLogger("knightconnect")


class ScrapeError(RuntimeError):
    """A safe, public diagnostic that does not contain database credentials."""


metadata = MetaData()
events = Table(
    "events", metadata,
    Column("event_id", String(32), primary_key=True),
    Column("name", Text, nullable=False),
    Column("description", Text, nullable=False),
    Column("starts_at", DateTime(timezone=True), nullable=False, index=True),
    Column("ends_at", DateTime(timezone=True), nullable=False, index=True),
    Column("location", Text), Column("hosts", JSON, nullable=False),
    Column("categories", JSON, nullable=False), Column("status", String(64)),
    Column("latitude", Float), Column("longitude", Float),
    Column("source_url", Text, nullable=False),
    Column("calendar_text", Text, nullable=False),
    Column("is_listed", Boolean, nullable=False, index=True),
    Column("first_seen_at", DateTime(timezone=True), nullable=False),
    Column("last_seen_at", DateTime(timezone=True), nullable=False),
)
runs = Table(
    "scrape_runs", metadata,
    Column("run_id", String(36), primary_key=True),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("finished_at", DateTime(timezone=True)),
    Column("status", String(32), nullable=False),
    Column("event_count", Integer),
)


def session():
    client = requests.Session()
    client.headers["User-Agent"] = AGENT
    client.mount("https://", HTTPAdapter(max_retries=Retry(
        total=4, backoff_factor=1, status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"], respect_retry_after_header=True)))
    return client


def robots(client):
    response = client.get(BASE + "/robots.txt", timeout=30)
    response.raise_for_status()
    policy = RobotFileParser()
    policy.parse(response.text.splitlines())
    return policy


def allowed(policy, url):
    if not policy.can_fetch(AGENT, url):
        raise ScrapeError("robots.txt disallows " + url)


def discovery(page, limit=None, delay=1.0):
    """Load all cards through the same Load More control used by visitors."""
    page.goto(LISTING, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_function("() => /Showing \\d+ out of \\d+ events\\./.test(document.body.innerText)", timeout=60000)
    selector = 'a[href^="/engage/event/"]'
    seen = set()
    for _ in range(2000):
        content = page.locator("body").inner_text()
        match = re.search(r"Showing (\d+) out of (\d+) events\.", content)
        if not match:
            raise ScrapeError("Event count disappeared; listing markup may have changed")
        displayed, total = map(int, match.groups())
        links = page.locator(selector).evaluate_all("els => els.map(e => e.getAttribute('href'))")
        ids = list(dict.fromkeys(re.fullmatch(r"/engage/event/(\d+)", link).group(1)
                                 for link in links if re.fullmatch(r"/engage/event/(\d+)", link)))
        if limit and len(ids) >= limit:
            return ids[:limit], False
        if displayed == total:
            if len(ids) != total:
                raise ScrapeError("Event card count does not match the site's total")
            return ids, True
        if displayed > total or displayed == 0 or not set(ids) - seen:
            raise ScrapeError("Listing pagination stalled or changed during collection; rerun")
        seen.update(ids)
        button = page.get_by_role("button", name="Load More", exact=True)
        button.wait_for(state="visible", timeout=30000)
        time.sleep(delay)
        button.click(timeout=30000)
        page.wait_for_function(
            "old => { const m = document.body.innerText.match(/Showing (\\d+) out of (\\d+) events\\./); return m && Number(m[1]) > old; }",
            arg=displayed, timeout=60000)
    raise ScrapeError("Listing exceeded pagination safety limit")


def utc(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=ZoneInfo("America/New_York"))
        return value.astimezone(timezone.utc)
    if isinstance(value, date):
        return datetime.combine(value, daytime.min, ZoneInfo("America/New_York")).astimezone(timezone.utc)
    raise ValueError("Invalid calendar date")


def values(component, key):
    items = component.get(key, [])
    if not isinstance(items, list):
        items = [items]
    result = []
    for item in items:
        if hasattr(item, "cats"):
            result.extend(str(cat) for cat in item.cats)
        else:
            result.append(str(item))
    return result


def parse_calendar(payload, event_id):
    components = Calendar.from_ical(payload).walk("VEVENT")
    if len(components) != 1:
        raise ValueError("Expected one event in calendar download")
    event = components[0]
    url = BASE + "/engage/event/" + event_id
    if str(event.get("URL", "")) != url or str(event.get("UID", "")) != url:
        raise ValueError("Calendar event identity differs from listing")
    name = str(event.get("SUMMARY", "")).strip()
    if not name:
        raise ValueError("Calendar is missing an event name")
    start = utc(event.decoded("DTSTART"))
    end = utc(event.decoded("DTEND"))
    if end < start:
        raise ValueError("Event ends before it starts")
    geo = event.get("GEO")
    return dict(event_id=event_id, name=name,
                description=str(event.get("DESCRIPTION", "")), starts_at=start, ends_at=end,
                location=str(event.get("LOCATION", "")), hosts=values(event, "X-HOSTS"),
                categories=values(event, "CATEGORIES"), status=str(event.get("STATUS", "")),
                latitude=float(geo.latitude) if geo else None,
                longitude=float(geo.longitude) if geo else None, source_url=url,
                calendar_text=payload.decode("utf-8-sig"))


def save(connection, rows, complete, observed_at):
    """Commit only after every calendar has been validated. Preserve first-seen time."""
    insert = pg_insert if connection.dialect.name == "postgresql" else sqlite_insert
    if complete:
        connection.execute(update(events).values(is_listed=False))
    for row in rows:
        record = {**row, "is_listed": True, "first_seen_at": observed_at, "last_seen_at": observed_at}
        stmt = insert(events).values(**record)
        stmt = stmt.on_conflict_do_update(index_elements=[events.c.event_id],
            set_={key: stmt.excluded[key] for key in record if key not in ("event_id", "first_seen_at")})
        connection.execute(stmt)


def run(database_url, limit=None, delay=1.0, headed=False, browser_channel=None):
    from uuid import uuid4
    engine = create_engine(database_url, pool_pre_ping=True)
    if engine.dialect.name not in ("sqlite", "postgresql"):
        raise ValueError("Use a SQLite or PostgreSQL database URL")
    metadata.create_all(engine)
    run_id = str(uuid4())
    observed = datetime.now(timezone.utc)
    lock = engine.connect()
    try:
        if engine.dialect.name == "postgresql":
            if not lock.execute(text("SELECT pg_try_advisory_lock(987231004)")).scalar():
                raise ScrapeError("Another scraper is already running")
        with engine.begin() as connection:
            connection.execute(runs.insert().values(run_id=run_id, started_at=observed, status="running"))
        try:
            with session() as client:
                policy = robots(client)
                allowed(policy, LISTING)
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=not headed, channel=browser_channel)
                    try:
                        page = browser.new_page()
                        ids, complete = discovery(page, limit, delay)
                    finally:
                        browser.close()
                LOG.info("Discovered %d events (full listing: %s)", len(ids), complete)
                rows = []
                for index, event_id in enumerate(ids, 1):
                    url = BASE + "/engage/event/" + event_id + ".ics"
                    allowed(policy, url)
                    time.sleep(delay)
                    response = client.get(url, timeout=(10, 60), allow_redirects=False)
                    if response.status_code != 200:
                        raise ScrapeError("Calendar fetch failed for event %s (HTTP %s)" % (event_id, response.status_code))
                    try:
                        rows.append(parse_calendar(response.content, event_id))
                    except Exception as error:
                        raise ScrapeError("Invalid calendar for event %s (%s)" % (event_id, type(error).__name__)) from error
                    if index % 25 == 0:
                        LOG.info("Downloaded %d / %d calendars", index, len(ids))
            with engine.begin() as connection:
                save(connection, rows, complete, observed)
                connection.execute(update(runs).where(runs.c.run_id == run_id).values(
                    status="complete" if complete else "limited", event_count=len(rows),
                    finished_at=datetime.now(timezone.utc)))
            LOG.info("Saved %d events; database transaction committed", len(rows))
            return len(rows)
        except Exception:
            with engine.begin() as connection:
                connection.execute(update(runs).where(runs.c.run_id == run_id).values(
                    status="failed", finished_at=datetime.now(timezone.utc)))
            raise
    finally:
        if engine.dialect.name == "postgresql":
            lock.execute(text("SELECT pg_advisory_unlock(987231004)"))
        lock.close()
        engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_url = os.getenv("DATABASE_URL", "sqlite:///events.db")
    if os.getenv("DATABASE_HOST"):
        query = {"sslmode": os.getenv("DATABASE_SSLMODE", "require")}
        if os.getenv("DATABASE_SSLROOTCERT"):
            query['sslrootcert'] = os.environ['DATABASE_SSLROOTCERT']
        default_url = URL.create("postgresql+psycopg", username=os.getenv("DATABASE_USER", "eventsadmin"),
            password=os.environ["DATABASE_PASSWORD"], host=os.environ["DATABASE_HOST"],
            port=int(os.getenv('DATABASE_PORT', '5432')), database=os.getenv("DATABASE_NAME", "events"), query=query)
    parser.add_argument("--database-url", default=default_url)
    parser.add_argument("--limit", type=int, help="Smoke test only; does not mark missing events unlisted")
    parser.add_argument("--delay", type=float, default=1.0, help="Seconds between requests/clicks (minimum 0.5)")
    parser.add_argument("--headed", action="store_true", help="Show Chromium for local debugging")
    parser.add_argument("--browser-channel", choices=["chrome", "msedge"], help="Use an installed browser instead of bundled Chromium")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.delay < 0.5:
        parser.error("--delay must be at least 0.5")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        run(args.database_url, args.limit, args.delay, args.headed, args.browser_channel)
    except Exception as error:
        # Do not print database URLs or raw exception strings that may contain credentials.
        detail = str(error) if isinstance(error, ScrapeError) else type(error).__name__
        LOG.error("Scrape failed: %s. Existing event data was preserved. Check connectivity, calendar availability and listing markup.", detail)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
