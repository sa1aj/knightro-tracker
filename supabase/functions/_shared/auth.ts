import {APIError,Data,config,hash,randomToken,rpc,supabase} from './backend.ts';
const AGE=14*86400;
export function cookie(token:string,age=AGE) {
  return `kt_session=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
}
export function cookieToken(req:Request):string {
  return req.headers.get('cookie')?.split(';').map(p=>p.trim()).find(p=>p.startsWith('kt_session='))?.slice(11)||'';
}
async function cipherKey() {
  return await crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',new TextEncoder().encode((await config()).SESSION_ENCRYPTION_KEY)),'AES-GCM',false,['encrypt','decrypt']);
}
export async function seal(data:Data) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await cipherKey(),new TextEncoder().encode(JSON.stringify(data))));
  return btoa(String.fromCharCode(...iv))+'.'+btoa(String.fromCharCode(...encrypted));
}
async function open(box:string) {
  const [a,b]=box.split('.');
  const iv=Uint8Array.from(atob(a),c=>c.charCodeAt(0)),bytes=Uint8Array.from(atob(b),c=>c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},await cipherKey(),bytes)));
}
export async function authRequest(path:string,body:Data) {
  const response=await supabase('/auth/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (!response.ok) {
    if (response.status===429) throw new APIError(429,'Too many login attempts. Try again later.',60);
    if (response.status>=500) throw new APIError(503,'Account service is temporarily unavailable.');
    throw new APIError(400,'Unable to sign in or create this account. Check your email and password.');
  }
  return await response.json();
}
export async function createSession(tokens:Data) {
  if (!tokens.access_token || !tokens.refresh_token || !tokens.user?.id) throw new APIError(503,'Account session could not be created. Please sign in again.');
  const token=randomToken();
  await rpc('session/create',tokens.user.id,{hash:await hash(token),box:await seal({access:tokens.access_token,refresh:tokens.refresh_token,expires:tokens.expires_at||Math.floor(Date.now()/1000)+tokens.expires_in})});
  return {id:tokens.user.id,cookie:cookie(token)};
}
export async function identity(req:Request,required=false):Promise<{id:string|null;access?:string;hash?:string}> {
  const token=cookieToken(req);
  if (!/^[a-f0-9]{64}$/.test(token)) { if (required) throw new APIError(401,'Sign in with your UCF account.'); return {id:null}; }
  const digest=await hash(token),session=await rpc('session/get',null,{hash:digest});
  if (!session) { if (required) throw new APIError(401,'Your session expired. Please sign in.'); return {id:null}; }
  let data:Data;
  try { data=await open(session.box); } catch { throw new APIError(503,'Account session could not be read.'); }
  if (data.expires<Math.floor(Date.now()/1000)+30) {
    let refreshed:Data;
    try { refreshed=await authRequest('token?grant_type=refresh_token',{refresh_token:data.refresh}); }
    catch(error) {
      if (error instanceof APIError && error.status===400) { await rpc('session/delete',null,{hash:digest}); if (!required) return {id:null}; throw new APIError(401,'Please sign in again.'); }
      throw error;
    }
    if (refreshed.user.id!==session.userId) throw new APIError(401,'Invalid session.');
    data={access:refreshed.access_token,refresh:refreshed.refresh_token,expires:refreshed.expires_at||Math.floor(Date.now()/1000)+refreshed.expires_in};
    const saved=await rpc('session/update',session.userId,{hash:digest,box:await seal(data)});
    if (!saved.ok) throw new APIError(401,'Please sign in again.');
  }
  const response=await supabase('/auth/v1/user',{},data.access);
  if (response.status>=500) throw new APIError(503,'Account service is temporarily unavailable.');
  if (!response.ok) { await rpc('session/delete',null,{hash:digest}); if (required) throw new APIError(401,'Please sign in again.'); return {id:null}; }
  const user=await response.json();
  if (user.id!==session.userId || !/@(ucf\.edu|knights\.ucf\.edu)$/i.test(user.email||'')) throw new APIError(401,'Invalid account session.');
  return {id:user.id,access:data.access,hash:digest};
}
