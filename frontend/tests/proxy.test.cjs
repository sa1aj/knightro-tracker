const {test} = require('node:test');
const assert = require('node:assert/strict');
const load = import('../api/proxy.mjs');

async function run(req, response, check) {
  const {default:handler} = await load;
  const original = global.fetch;
  const oldURL = process.env.KNIGHTRO_BACKEND_URL, oldToken = process.env.KNIGHTRO_PROXY_TOKEN;
  process.env.KNIGHTRO_BACKEND_URL = 'https://hq.example.org';
  process.env.KNIGHTRO_PROXY_TOKEN = 'a'.repeat(64);
  let fetched = false;
  const res = {headers:{}, setHeader(key,value) {this.headers[key]=value;}, end(value) {this.body=value;}};
  global.fetch = async (url, options) => {fetched=true; if (check) check(url, options); return response;};
  try { await handler(req,res); return {...res,fetched}; }
  finally {
    global.fetch=original;
    if (oldURL === undefined) delete process.env.KNIGHTRO_BACKEND_URL; else process.env.KNIGHTRO_BACKEND_URL=oldURL;
    if (oldToken === undefined) delete process.env.KNIGHTRO_PROXY_TOKEN; else process.env.KNIGHTRO_PROXY_TOKEN=oldToken;
  }
}
const headers = {'content-type':'application/json','x-forwarded-for':'203.0.113.7','origin':'https://tracker.example.org','cookie':'kt_session=test'};
test('proxy preserves verified JPEG payload, Origin, cookies, query, and server cookie attributes', async () => {
  const photo = {photo:'data:image/jpeg;base64,frame',captureToken:'issued-token'};
  const result = await run({method:'POST',headers,body:photo,query:{route:'sightings',q:'a b'}},
    new Response(JSON.stringify({points:2}),{status:201,headers:{'Content-Type':'application/json','Set-Cookie':'kt_session=rotated; Path=/api; HttpOnly; Secure; SameSite=Lax'}}),
    (url,options) => {
      assert.equal(String(url),'https://hq.example.org/api/sightings?q=a+b');
      assert.equal(options.headers.Cookie,'kt_session=test'); assert.equal(options.headers.Origin,headers.origin);
      assert.equal(options.headers['X-Knightro-Client-IP'],'203.0.113.7');
      assert.equal(options.headers['X-Knightro-Proxy-Token'],'a'.repeat(64));
      assert.deepEqual(JSON.parse(options.body.toString()),photo); assert.equal(options.redirect,'manual');
    });
  assert.equal(result.statusCode,201); assert.equal(result.headers['Cache-Control'],'no-store');
  assert.match(result.headers['Set-Cookie'][0],/HttpOnly; Secure; SameSite=Lax/);
});
test('proxy rejects traversal, duplicate route, oversize, unsupported method and non-JSON uploads before forwarding', async () => {
  for (const [req,status] of [
    [{method:'GET',headers,query:{route:'../auth'}},400],
    [{method:'GET',headers,query:{route:['sightings','auth/session']}},400],
    [{method:'POST',headers:{...headers,'content-length':'3000001'},query:{route:'sightings'},body:{}},413],
    [{method:'POST',headers:{'content-type':'text/plain'},query:{route:'sightings'},body:'x'},415],
    [{method:'DELETE',headers,query:{route:'sightings'}},405],
  ]) {
    const result = await run(req); assert.equal(result.statusCode,status); assert.equal(result.fetched,false);
  }
});
test('proxy never follows backend redirects or accepts a spoofed application client-IP header', async () => {
  const result = await run({method:'GET',headers:{...headers,'x-knightro-client-ip':'192.0.2.99'},query:{route:'game'}},
    new Response(null,{status:302,headers:{Location:'https://elsewhere.example/'}}),
    (_url, options) => assert.equal(options.headers['X-Knightro-Client-IP'],'203.0.113.7'));
  assert.equal(result.statusCode,502);
});
test('upstream URL is restricted to the configured HTTPS origin', async () => {
  const {upstreamURL} = await load;
  for (const bad of ['http://hq.example.org','https://user:pass@hq.example.org','https://hq.example.org/other','https://hq.example.org/?token=x']) {
    assert.throws(() => upstreamURL(bad,'game'));
  }
});
