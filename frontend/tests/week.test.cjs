const assert = require('node:assert/strict');
const {test} = require('node:test');
const {dayWindow, overlaps, eventEnd} = require('../js/map-utils.js');
const at = (iso) => Date.parse(iso) / 1000;

test('the window runs from the start of today to the start of the day 7 days later, in America/New_York', () => {
  const win = dayWindow(at('2026-10-15T16:00:00Z')); // Thursday afternoon in Orlando
  assert.equal(win.start, at('2026-10-15T04:00:00Z')); // Thursday 00:00 EDT
  assert.equal(win.end, at('2026-10-22T04:00:00Z'));   // next Thursday 00:00 EDT (window covers Thu → Wed)
});

test('late evening in Orlando is still "today", even though it is tomorrow in UTC', () => {
  const win = dayWindow(at('2026-10-16T03:30:00Z')); // Thursday 23:30 EDT
  assert.equal(win.start, at('2026-10-15T04:00:00Z'));
  assert.equal(dayWindow(at('2026-10-16T04:00:00Z')).start, at('2026-10-16T04:00:00Z')); // Friday 00:00 starts a new window
});

test('a window crossing the end of daylight saving uses each local midnight', () => {
  const win = dayWindow(at('2026-10-30T15:00:00Z')); // Friday; DST ends Sunday 1 Nov 2026
  assert.equal(win.start, at('2026-10-30T04:00:00Z')); // Friday 00:00 EDT
  assert.equal(win.end, at('2026-11-06T05:00:00Z'));   // Friday 00:00 EST
  assert.equal((win.end - win.start) / 3600, 169);
});

test('a window crossing the start of daylight saving is one hour shorter', () => {
  const win = dayWindow(at('2027-03-12T15:00:00Z')); // Friday; DST starts Sunday 14 Mar 2027
  assert.equal(win.start, at('2027-03-12T05:00:00Z'));
  assert.equal(win.end, at('2027-03-19T04:00:00Z'));
  assert.equal((win.end - win.start) / 3600, 167);
});

test('windows spanning a month and a year boundary', () => {
  assert.deepEqual(dayWindow(at('2026-10-28T16:00:00Z')), {start: at('2026-10-28T04:00:00Z'), end: at('2026-11-04T05:00:00Z')});
  assert.deepEqual(dayWindow(at('2026-12-29T17:00:00Z')), {start: at('2026-12-29T05:00:00Z'), end: at('2027-01-05T05:00:00Z')});
});

test('events overlapping the window are included: in-progress, multi-day, all-day, and no end time', () => {
  const win = dayWindow(at('2026-10-15T16:00:00Z'));
  const ev = (start, end) => ({startsAt: at(start), endsAt: end && at(end)});
  assert.ok(overlaps(ev('2026-10-13T14:00:00Z', '2026-10-16T15:00:00Z'), win), 'multi-day, started earlier, still running');
  assert.ok(overlaps(ev('2026-10-21T22:00:00Z', '2026-10-23T02:00:00Z'), win), 'starts Wednesday, runs past the window');
  assert.ok(overlaps(ev('2026-10-17T04:00:00Z', '2026-10-18T04:00:00Z'), win), 'all-day Saturday');
  assert.ok(overlaps({startsAt: at('2026-10-18T18:00:00Z')}, win), 'no end time = an instant at its start');
  assert.ok(!overlaps(ev('2026-10-22T04:00:00Z', '2026-10-22T06:00:00Z'), win), 'starts exactly at the window end');
  assert.ok(!overlaps(ev('2026-10-14T20:00:00Z', '2026-10-15T04:00:00Z'), win), 'ended at the window start');
  assert.equal(eventEnd({startsAt: 100}), 100);
  assert.equal(eventEnd({startsAt: 100, endsAt: 50}), 100, 'an end before the start is treated as the start');
});
