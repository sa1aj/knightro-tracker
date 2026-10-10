const assert = require('node:assert/strict');
const { test } = require('node:test');
const { opacity, cluster, contains, place } = require('../js/map-utils.js');
const campuses = require('../data/campuses.json');

test('pins remain at least 55% visible until removed by expiry and clamp clock skew', () => {
  assert.equal(opacity(0, 0, 1200), 1);
  assert.equal(opacity(0, 600, 1200), .775);
  assert.equal(opacity(0, 1200, 1200), .55);
  assert.equal(opacity(0, 1300, 1200), .55);
  assert.equal(opacity(100, 0, 1200), 1);
});
test('footprints take precedence over a closer center, and distant labels use only campus', () => {
  const buildings = [
    {name:'Actual Building',lat:28.602,long:-81.202,polygons:[[[-81.201,28.60],[-81.20,28.60],[-81.20,28.603],[-81.201,28.603]]]},
    {name:'Nearby Building',lat:28.602,long:-81.2004,polygons:[]},
  ];
  assert.equal(place(28.602,-81.2005,buildings,campuses),'At Actual Building');
  assert.equal(place(28.609,-81.205,buildings,campuses),'Main Campus');
});
test('nearby pins stack and separate as map zoom increases; coincident pins remain accessible', () => {
  const points = [{x:0,y:0}, {x:0,y:0}, {x:30,y:0}, {x:100,y:0}];
  assert.deepEqual(cluster(points, p => p).map(g => g.items.length), [3,1]);
  assert.deepEqual(cluster(points, p => ({x:p.x*4,y:p.y*4})).map(g => g.items.length), [2,1,1]);
});
test('all campus centers are allowed and the space between campuses is excluded', () => {
  for (const campus of campuses) assert.ok(contains(campus,campus.center));
  assert.ok(campuses.every(c => !contains(c,{lat:28.50,lng:-81.30})));
});
