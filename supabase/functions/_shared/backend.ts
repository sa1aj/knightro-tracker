export type Data = Record<string, any>;
export class APIError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) { super(message); }
}
export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new APIError(503, 'Knightro HQ is being configured. Please try again later.');
  return value;
}
let configuration:Data|null=null;
let configLoaded=0;
export async function config():Promise<Data> {
  if (!configuration || Date.now()-configLoaded>60000) {
    configuration=await rpc('backend/config'); configLoaded=Date.now();
  }
  return configuration!;
}
export function clearConfig() { configuration=null; }
export function allowedFrontendOrigin(origin:string|null,settings:Data):boolean {
  const origins=[settings.PUBLIC_ORIGIN];
  if (settings.PUBLIC_ORIGINS) {
    try {
      const additional=JSON.parse(settings.PUBLIC_ORIGINS);
      if (!Array.isArray(additional) || additional.length>10 || !additional.every(value=>
        typeof value==='string' && new URL(value).protocol==='https:' && new URL(value).origin===value)) throw new Error();
      origins.push(...additional);
    } catch { throw new APIError(503,'The website origin configuration is invalid.'); }
  }
  return origin!==null && origins.includes(origin);
}
export function json(value: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  if (cookie) headers.set('Set-Cookie',cookie);
  if ((value as Data)?.retryAfter) headers.set('Retry-After',String((value as Data).retryAfter));
  return new Response(JSON.stringify(value),{status,headers});
}
export function fail(error: unknown): Response {
  if (error instanceof APIError) return json({error:error.message,...(error.retryAfter ? {retryAfter:error.retryAfter} : {})},error.status);
  // Never log credentials, tokens, precise locations, uploaded images, or upstream error bodies.
  console.error('Knightro operation failed:',error instanceof Error ? error.name : 'Unknown');
  return json({error:'Knightro HQ is temporarily unavailable. Please retry.'},503);
}
export async function equalSecret(a: string,b: string): Promise<boolean> {
  const encode = new TextEncoder();
  const [x,y] = await Promise.all([crypto.subtle.digest('SHA-256',encode.encode(a)),crypto.subtle.digest('SHA-256',encode.encode(b))]);
  let difference = 0;
  new Uint8Array(x).forEach((value,index) => difference |= value ^ new Uint8Array(y)[index]);
  return a.length>0 && b.length>0 && difference===0;
}
export async function requireSecret(req: Request,header: string,name: string) {
  const value=(await config())[name];
  if (!value) throw new APIError(503,'Knightro HQ is being configured. Please try again later.');
  if (!await equalSecret(req.headers.get(header)||'',value)) throw new APIError(403,'Unrecognized caller.');
}
export async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,'0')).join('');
}
export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function boundedBody(req: Request,maximum: number): Promise<Data> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new APIError(415,'Use application/json.');
  if (Number(req.headers.get('content-length'))>maximum) throw new APIError(413,'Request is too large.');
  const reader = req.body?.getReader();
  if (!reader) throw new APIError(400,'Missing request body.');
  let size=0; const chunks:Uint8Array[]=[];
  for (;;) {
    const {done,value}=await reader.read(); if (done) break;
    size+=value.length;
    if (size>maximum) { await reader.cancel(); throw new APIError(413,'Request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset=0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
  try {
    const data=JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data!=='object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new APIError(400,'Invalid JSON body.'); }
}
export async function supabase(path:string,init:RequestInit={},bearer?:string):Promise<Response> {
  const key=env('SUPABASE_SERVICE_ROLE_KEY');
  const headers=new Headers(init.headers); headers.set('apikey',key); headers.set('Authorization','Bearer '+(bearer||key));
  return await fetch(env('SUPABASE_URL')+path,{...init,headers,redirect:'error',signal:AbortSignal.timeout(12000)});
}
export async function rpc(action:string,actor:string|null=null,payload:Data={}):Promise<any> {
  const response=await supabase('/rest/v1/rpc/kt_rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,actor,payload})});
  if (!response.ok) throw new APIError(503,'The application database is unavailable.');
  const data=await response.json();
  if (data?.httpStatus) throw new APIError(data.httpStatus,data.error,data.retryAfter);
  return data;
}
export async function limit(key:string,count:number,window:number) {
  const result=await rpc('rate',null,{key:await hash(key),limit:count,window});
  if (!result.allowed) throw new APIError(429,'Too many requests. Please wait and retry.',result.retryAfter);
}
export function text(data:Data,key:string,min:number,max:number,optional=false):string {
  const value=data[key]??(optional?'':undefined);
  if (typeof value!=='string' || value.trim().length<min || value.trim().length>max) throw new APIError(400,`${key} must be ${min}–${max} characters.`);
  return value.trim();
}
export function ucfEmail(data:Data):string {
  const value=text(data,'email',3,254).toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(ucf\.edu|knights\.ucf\.edu)$/.test(value)) throw new APIError(400,'Use your @ucf.edu or @knights.ucf.edu address.');
  return value;
}
export function location(data:Data) {
  if (![data.lat,data.long].every(v=>typeof v==='number' && Number.isFinite(v))) throw new APIError(400,'Choose a valid map location.');
}
export function uuid(value:unknown):string {
  if (typeof value!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new APIError(400,'Invalid report or account ID.');
  return value;
}
