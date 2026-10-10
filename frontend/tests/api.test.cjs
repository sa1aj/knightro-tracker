const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function api(fetch, config = {}) {
  const window = {KT:{CONFIG:{API_BASE:'/api',SIGHTINGS_API:'/api',DEPLOYMENT:'app', ...config},mapUtils:require('../js/map-utils.js')}};
  const wrapped = async (...args) => ({headers:{get:() => 'application/json'}, ...await fetch(...args)});
  vm.runInNewContext(fs.readFileSync(require.resolve('../js/api.js'),'utf8'), {window, fetch:wrapped, AbortSignal});
  return window.KT.api;
}
test('verified photo submission keeps the photo/token and server points/cooldown on same-origin API', async () => {
  const payload = {lat:28.6,long:-81.2,photo:'data:image/jpeg;base64,test',captureToken:'real-token',caption:'Knightro'};
  const client = api(async (url, options) => {
    assert.equal(url,'/api/sightings'); assert.equal(options.credentials,'same-origin');
    assert.deepEqual(JSON.parse(options.body),payload);
    return {ok:true,json:async () => ({points:2,nextSightingAt:12345,photoUrl:'/api/photos/report'})};
  });
  const result = await client.postSighting(payload);
  assert.equal(result.points,2); assert.equal(result.nextSightingAt,12345);
});
test('camera tokens are issued by the account API and events use server classification', async () => {
  const requests = [];
  const client = api(async (url, options) => { requests.push([url,options.method]); return {ok:true,json:async () => ({})}; });
  await client.cameraSession(); await client.getEvents();
  assert.deepEqual(requests,[['/api/camera-session','POST'],['/api/events',undefined]]);
});
test('session outage remains an error instead of silently pretending to be a signed-out session', async () => {
  const client = api(async () => ({ok:false,status:404,json:async () => {throw new Error('not JSON');}}));
  await assert.rejects(client.getSession(), error => error.status === 404);
});

test('static mode preserves anonymous sightings without forwarding cookies or promising account rewards', async () => {
  const client = api(async (url, options) => {
    assert.equal(url, 'https://sightings.example.org/sightings');
    assert.equal(options.credentials, 'omit');
    assert.deepEqual(JSON.parse(options.body), {lat:28.6,long:-81.2,caption:'Knightro'});
    return {ok:true,json:async () => ({sightingId:'anonymous',timestamp:123})};
  }, {DEPLOYMENT:'static',API_BASE:null,SIGHTINGS_API:'https://sightings.example.org'});
  assert.equal((await client.getSession()).accounts,false);
  await assert.rejects(client.cameraSession(), error => error.status === 'unavailable');
  const result = await client.postSighting({lat:28.6,long:-81.2,caption:'Knightro',photo:'private-photo',captureToken:'private-token'});
  assert.equal(result.status,'anonymous'); assert.equal(result.points,null); assert.equal(result.photoUrl,null);
});

test('static mode keeps the latest upstream browser event classification', async () => {
  const client = api(async url => ({ok:true,json:async () => url === 'events.json'
    ? {events:[{eventId:'ordinary',title:'Chess club',location:'Student Union',startsAt:Date.now()/1000,endsAt:Date.now()/1000+3600}]}
    : {buildings:[]}}), {DEPLOYMENT:'static',API_BASE:null,STATIC_EVENTS_URL:'events.json',BUILDINGS_URL:'buildings.json'});
  const result = await client.getEvents();
  assert.equal(result.filter,'likely-knightro'); assert.equal(result.events.length,0);
});
