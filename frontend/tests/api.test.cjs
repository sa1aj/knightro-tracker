const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function api(fetch, config = {}) {
  const CONFIG = Object.assign(config, {API_BASE:'/api',SIGHTINGS_API:'/api',DEPLOYMENT:'app', ...config});
  const window = {KT:{CONFIG,mapUtils:require('../js/map-utils.js')}};
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

const STATIC_FALLBACK = {name:'static',API_BASE:null,SIGHTINGS_API:'https://sightings.example.org',ACCOUNTS:false,STATIC_EVENTS_URL:'events.json'};
function hosted(fetch) {
  const config = {DEPLOYMENT:'app',ACCOUNTS:true,FALLBACK:STATIC_FALLBACK,BUILDINGS_URL:'buildings.json'};
  const client = api(fetch, config);
  return {client, config};
}

test('Vercel with no backend connected falls back to the static event file and AWS sightings', async () => {
  const seen = [];
  const {client, config} = hosted(async url => {
    seen.push(url);
    if (url.startsWith('/api/')) return {ok:false,status:503,json:async () => ({error:'Knightro HQ is being configured. Please try again later.'})};
    if (url === 'events.json') return {ok:true,json:async () => ({events:[]})};
    if (url === 'buildings.json') return {ok:true,json:async () => ({buildings:[]})};
    return {ok:true,json:async () => ({sightings:[]})};
  });
  await client.ready;
  assert.equal(client.deployment,'static'); assert.equal(config.ACCOUNTS,false);
  assert.equal((await client.getSession()).accounts,false);
  await client.getEvents(); await client.getSightings();
  assert.deepEqual(seen,['/api/auth/session','events.json','buildings.json','https://sightings.example.org/sightings']);
});

test('a plain 404 (no app server) also falls back to static', async () => {
  const {client} = hosted(async () => ({ok:false,status:404,headers:{get:() => 'text/html'},json:async () => { throw new Error('html'); }}));
  await client.ready;
  assert.equal(client.deployment,'static');
});

test('a connected backend, its own outage, or being offline keeps app mode', async () => {
  const answers = [
    async () => ({ok:true,json:async () => ({user:null})}),
    async () => ({ok:false,status:503,json:async () => ({error:'Knightro HQ is temporarily unavailable.'})}),
    async () => { throw new TypeError('Failed to fetch'); },
  ];
  for (const answer of answers) {
    const {client, config} = hosted(answer);
    await client.ready;
    assert.equal(client.deployment,'app'); assert.equal(config.API_BASE,'/api'); assert.equal(config.ACCOUNTS,true);
  }
});
