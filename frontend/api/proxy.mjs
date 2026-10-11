// Private Vercel environment variables, never browser configuration.
import {isIP} from 'node:net';

const MAX_BODY = 3000000;
function reply(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({error}));
}

export function upstreamURL(base, route, query = {}) {
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || !['/','/functions/v1/knightro-api','/functions/v1/knightro-api/'].includes(url.pathname)
      || (url.port && url.port !== '443')) throw new Error('Invalid backend origin');
  if (typeof route !== 'string' || !route || route.split('/').some(part => !/^[a-zA-Z0-9_-]+$/.test(part))) {
    throw new TypeError('Invalid API route');
  }
  url.pathname = url.pathname === '/' ? '/api/' + route : '/functions/v1/knightro-api/' + route;
  for (const [key, value] of Object.entries(query)) {
    if (key === 'route') continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return url;
}

export default async function handler(req, res) {
  const base = process.env.KNIGHTRO_BACKEND_URL, token = process.env.KNIGHTRO_PROXY_TOKEN;
  if (!base || !token || !/^[a-zA-Z0-9_-]{40,256}$/.test(token)) return reply(res, 503, 'Knightro HQ is being configured. Please try again later.');
  if (!['GET', 'POST'].includes(req.method)) return reply(res, 405, 'Method not allowed.');
  let url;
  try { url = upstreamURL(base, req.query?.route, req.query); }
  catch (error) { return reply(res, error instanceof TypeError ? 400 : 503, 'Invalid API route or backend configuration.'); }
  const headers = {'X-Knightro-Proxy-Token': token};
  // Vercel overwrites x-forwarded-for at its edge. Do not forward client-supplied app headers.
  const address = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (isIP(address)) headers['X-Knightro-Client-IP'] = address;
  if (req.headers.cookie) headers.Cookie = req.headers.cookie;
  if (req.headers.origin) headers.Origin = req.headers.origin;
  let body;
  if (req.method === 'POST') {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return reply(res, 415, 'Use application/json.');
    headers['Content-Type'] = 'application/json';
    if (Number(req.headers['content-length']) > MAX_BODY) return reply(res, 413, 'Request is too large.');
    try {
      if (req.body !== undefined) body = Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      else {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) return reply(res, 413, 'Request is too large.');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
    } catch { return reply(res, 400, 'Invalid request body.'); }
    if (body.length > MAX_BODY) return reply(res, 413, 'Request is too large.');
  }
  try {
    const response = await fetch(url, {method: req.method, headers, body, redirect:'manual', signal:AbortSignal.timeout(req.method === 'POST' && req.query?.route === 'sightings' ? 24000 : 20000)});
    // Never follow redirects carrying a user's cookie or the private gateway token.
    if (response.status >= 300 && response.status < 400) return reply(res, 502, 'Knightro HQ returned an unexpected redirect.');
    const data = Buffer.from(await response.arrayBuffer());
    res.statusCode = response.status;
    for (const name of ['content-type', 'retry-after', 'x-content-type-options']) {
      const value = response.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch { return reply(res, 502, 'Knightro HQ is temporarily unreachable. Please try again later.'); }
}
