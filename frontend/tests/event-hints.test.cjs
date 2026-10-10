// The static site's event filter must agree with the server (backend/campus.py event_hint).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const util = require('../js/map-utils.js');
const buildings = require(path.join(__dirname, '../data/buildings.json')).buildings;
const feed = require(path.join(__dirname, '../data/events.json'));
const NOW = 1791660979; // feed generatedAt

test('real feed yields the same likely-Knightro hints as the server', () => {
  const hints = util.eventHints(feed, buildings, NOW).events.map(e => [e.title, e.buildingName, e.probability]);
  assert.deepStrictEqual(hints, [
    ['UCF Homecoming Kickoff', 'Reflecting Pond', 0.85],
    ['oSTEM Backrooms Watch Party', 'Psychology Building', 0.95],
    ['UCF Homecoming Spirit Splash 2026', 'Reflecting Pond', 0.85],
    ['UCF Football vs BYU', 'Acrisure Bounce House (Football Stadium)', 0.8],
  ]);
});

test('negated, unmapped and ordinary events produce no hint', () => {
  const base = { eventId: 'x', startsAt: NOW + 100, endsAt: NOW + 1000, hosts: [] };
  assert.strictEqual(util.eventHint({ ...base, title: 'Chess club', location: 'Student Union' }, buildings), null);
  assert.strictEqual(util.eventHint({ ...base, title: 'Knightro will not attend', location: 'Student Union' }, buildings), null);
  assert.strictEqual(util.eventHint({ ...base, title: 'Meet Knightro', location: 'Online' }, buildings), null);
  assert.strictEqual(util.eventHint({ ...base, title: 'Meet Knightro', location: 'Student Union Room 218' }, buildings).buildingId, '52');
});
