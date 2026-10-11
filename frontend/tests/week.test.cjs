const assert = require('node:assert/strict');
const {test} = require('node:test');
const {weekRange, overlaps} = require('../js/map-utils.js');
const at = (iso) => Date.parse(iso) / 1000;

test('the week runs Monday 00:00 to the next Monday 00:00 in America/New_York', () => {
  const week = weekRange(at('2026-10-14T16:00:00Z')); // Wednesday afternoon in Orlando
  assert.equal(week.start, at('2026-10-12T04:00:00Z')); // Monday 00:00 EDT
  assert.equal(week.end, at('2026-10-19T04:00:00Z'));
});

test('late Sunday night in Orlando is still the same week, even though it is Monday in UTC', () => {
  const week = weekRange(at('2026-10-19T03:30:00Z')); // Sunday 23:30 EDT
  assert.equal(week.start, at('2026-10-12T04:00:00Z'));
  assert.equal(weekRange(at('2026-10-19T04:00:00Z')).start, at('2026-10-19T04:00:00Z')); // Monday 00:00 starts the next week
});

test('a week crossing the end of daylight saving uses each local midnight', () => {
  const week = weekRange(at('2026-10-30T15:00:00Z')); // DST ends Sunday 1 Nov 2026
  assert.equal(week.start, at('2026-10-26T04:00:00Z')); // Monday 00:00 EDT
  assert.equal(week.end, at('2026-11-02T05:00:00Z'));   // Monday 00:00 EST
  assert.equal((week.end - week.start) / 3600, 169);
});

test('weeks spanning a month and year boundary', () => {
  const week = weekRange(at('2026-12-31T17:00:00Z')); // Thursday
  assert.equal(week.start, at('2026-12-28T05:00:00Z'));
  assert.equal(week.end, at('2027-01-04T05:00:00Z'));
});

test('events overlapping the week are included, including multi-day and all-day events', () => {
  const week = weekRange(at('2026-10-14T16:00:00Z'));
  const ev = (start, end) => ({startsAt: at(start), endsAt: at(end)});
  assert.ok(overlaps(ev('2026-10-09T14:00:00Z', '2026-10-12T15:00:00Z'), week), 'started last week, ends this Monday');
  assert.ok(overlaps(ev('2026-10-18T22:00:00Z', '2026-10-20T02:00:00Z'), week), 'starts Sunday, ends next week');
  assert.ok(overlaps(ev('2026-10-15T04:00:00Z', '2026-10-16T04:00:00Z'), week), 'all-day Thursday');
  assert.ok(overlaps(ev('2026-10-13T18:00:00Z', '2026-10-13T18:00:00Z'), week), 'zero-length listing');
  assert.ok(!overlaps(ev('2026-10-19T04:00:00Z', '2026-10-19T06:00:00Z'), week), 'next Monday');
  assert.ok(!overlaps(ev('2026-10-11T20:00:00Z', '2026-10-12T04:00:00Z'), week), 'ends exactly at the week start');
});
