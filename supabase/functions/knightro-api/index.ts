import {APIError,allowedFrontendOrigin,boundedBody,config,fail,hash,json,limit,location,randomToken,requireSecret,rpc,supabase,text,ucfEmail,uuid} from '../_shared/backend.ts';
import {authRequest,cookie,cookieToken,createSession,identity} from '../_shared/auth.ts';
import {cleanPhoto} from '../_shared/photos.ts';

const reads=new Set(['auth/session','sightings','leaderboard','events','game','my-reports','push/config','admin/state','admin/users','admin/test-events','admin/test-sightings','admin/sightings','admin/log']);
const writes=new Set(['auth/signup','auth/login','auth/logout','camera-session','sightings','presence','push/subscribe','push/unsubscribe','admin/mode','admin/cooldown','admin/points','admin/test-events','admin/test-events/delete','admin/test-sightings','admin/sightings/remove','admin/test-data/clear']);

function validateSubscription(value:any) {
  try {
    const url=new URL(value.endpoint),host=url.hostname.toLowerCase();
    const allowed=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host)||host.endsWith('.notify.windows.com');
    if(!allowed || url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || value.endpoint.length>2048) throw new Error();
    for(const [key,size] of [['p256dh',65],['auth',16]] as const) {
      const encoded=value.keys[key];
      if(typeof encoded!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(encoded)) throw new Error();
      const decoded=atob(encoded.replace(/-/g,'+').replace(/_/g,'/'));
      if(decoded.length!==size || (key==='p256dh' && decoded.charCodeAt(0)!==4)) throw new Error();
    }
    return {endpoint:value.endpoint,keys:{p256dh:value.keys.p256dh,auth:value.keys.auth}};
  } catch { throw new APIError(400,'Invalid or unsupported push subscription.'); }
}

Deno.serve(async req=> {
  try {
    // Custom authentication is deliberate: only our private Vercel gateway may call this API.
    // No CORS headers are returned and browser session tokens never enter client JavaScript.
    await requireSecret(req,'x-knightro-proxy-token','PROXY_TOKEN');
    const settings=await config(),url=new URL(req.url);
    const route=url.pathname.replace(/^.*\/knightro-api\/?/,'').replace(/^api\//,'');
    if(!['GET','POST'].includes(req.method)) throw new APIError(405,'Method not allowed.');
    if(req.method==='POST' && !allowedFrontendOrigin(req.headers.get('origin'),settings)) throw new APIError(403,'Unrecognized request origin.');
    if(req.method==='GET' && !reads.has(route) && !/^photos\/[a-f0-9-]{36}$/i.test(route)) throw new APIError(404,'API route not found.');
    if(req.method==='POST' && !writes.has(route)) throw new APIError(404,'API route not found.');
    const data=req.method==='POST'?await boundedBody(req,route==='sightings'?3000000:16384):{};
    const ip=req.headers.get('x-knightro-client-ip');
    if(req.method==='POST') await limit('ip:'+ip,120,60);

    if(['auth/signup','auth/login'].includes(route)) {
      const email=ucfEmail(data),password=data.password;
      if(typeof password!=='string'||password.length<12||password.length>128) throw new APIError(400,'Use a password with 12–128 characters.');
      await limit('auth:ip:'+ip,20,900); await limit('auth:email:'+email,10,900);
      if(route==='auth/signup') {
        const displayName=text(data,'displayName',2,30);
        // Explicit password-only signup. Supabase's admin endpoint skips outgoing email.
        // "email_confirm" here enables login; our app explicitly labels the address unverified.
        await authRequest('admin/users',{email,password,email_confirm:true,user_metadata:{displayName},app_metadata:{ucf_email_verified:false}});
      }
      const tokens=await authRequest('token?grant_type=password',{email,password});
      const session=await createSession(tokens);
      return json(await rpc('GET auth/session',session.id),200,session.cookie);
    }
    if(route==='auth/logout') {
      const current=await identity(req);
      await rpc('session/delete',null,{hash:await hash(cookieToken(req))});
      if(current.access) {
        // Revoke the refresh token for this browser, without logging out other devices.
        const response=await supabase('/auth/v1/logout?scope=local',{method:'POST'},current.access);
        if(!response.ok && response.status!==401) console.error('Refresh-token revocation unavailable');
      }
      return json({ok:true},200,cookie('',0));
    }
    const required=req.method==='POST'||route==='my-reports'||route.startsWith('admin/');
    const user=await identity(req,required);
    if(req.method==='POST') await limit('user:'+user.id,60,60);
    if(route==='push/config') return json({enabled:!!settings.VAPID_PUBLIC_KEY,publicKey:settings.VAPID_PUBLIC_KEY||null});
    if(route.startsWith('photos/')) {
      const result=await rpc('GET photo',user.id,{id:uuid(route.slice(7))});
      const response=await supabase('/storage/v1/object/authenticated/knightro-photos/'+result.path);
      if(!response.ok) throw new APIError(404,'Photo not found.');
      return new Response(response.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(req.method==='GET') return json(await rpc('GET '+route,user.id,route==='admin/users'?{q:(url.searchParams.get('q')||'').slice(0,60)}:{}));
    if(route==='camera-session') {
      const token=randomToken(),result=await rpc('POST camera-session',user.id,{hash:await hash(token)});
      return json({...result,captureToken:token});
    }
    if(route==='sightings') {
      location(data); text(data,'caption',0,200,true);
      const id=uuid(data.requestId),capture=text(data,'captureToken',40,100);
      // A retry after a lost response returns the committed sighting even if the capture expired.
      const previous=await rpc('sighting/existing',user.id,{id});
      if(previous) return json(previous,201);
      const photo=cleanPhoto(data.photo);
      const payload={id,lat:data.lat,long:data.long,caption:data.caption||'',captureHash:await hash(capture),bytes:photo.length};
      const reservation=await rpc('photo/reserve',user.id,payload);
      const response=await supabase('/storage/v1/object/knightro-photos/'+reservation.path,{method:'POST',headers:{'Content-Type':'image/jpeg','x-upsert':'false'},body:new Uint8Array(photo)});
      // Existing immutable object can be from this same request's earlier upload.
      if(!response.ok) {
        const result=await response.json().catch(()=>({}));
        if(![409,'409','Duplicate'].includes(result.statusCode)&&result.error!=='Duplicate') throw new APIError(503,'Photo upload failed. Please retry.');
      }
      // Failed commits leave a reserved object for scheduled cleanup; never delete a possibly committed photo.
      return json(await rpc('POST sightings',user.id,payload),201);
    }
    if(['presence','admin/test-sightings','admin/test-events'].includes(route)) location(data);
    if(route==='push/subscribe') data.subscription=validateSubscription(data.subscription);
    if(route==='push/unsubscribe') text(data,'endpoint',1,2048);
    if(['admin/mode','admin/cooldown'].includes(route)&&typeof data.enabled!=='boolean') throw new APIError(400,'Choose on or off.');
    if(['admin/points','admin/test-events/delete','admin/sightings/remove','admin/test-data/clear'].includes(route)&&data.confirm!==true) throw new APIError(400,'Confirm this action before applying it.');
    if(route==='admin/points') {
      uuid(data.userId);text(data,'reason',3,140);
      if(!Number.isInteger(data.amount)||data.amount===0||Math.abs(data.amount)>1000||!/^[A-Za-z0-9-]{8,64}$/.test(data.requestId||'')) throw new APIError(400,'Invalid point adjustment.');
    }
    if(route==='admin/sightings/remove') {uuid(data.sightingId);text(data,'reason',3,140);}
    if(route==='admin/test-sightings') text(data,'caption',0,200,true);
    if(route==='admin/test-events') {
      data.title=text(data,'title',3,80);data.description=text(data,'description',0,400,true);
      const now=Math.floor(Date.now()/1000);data.endsAt??=data.startsAt+3600;
      if(!Number.isInteger(data.startsAt)||!Number.isInteger(data.endsAt)||data.startsAt<now-86400||data.startsAt>now+60*86400||data.endsAt<=data.startsAt||data.endsAt>data.startsAt+48*3600) throw new APIError(400,'Choose valid event start and end times.');
    }
    if(['admin/test-events','admin/test-events/delete'].includes(route)&&data.eventId!==undefined) {
      if(typeof data.eventId!=='string'||!data.eventId.startsWith('test-')) throw new APIError(400,'Invalid test event ID.');
      uuid(data.eventId.slice(5));
    }
    return json(await rpc('POST '+route,user.id,data));
  } catch(error) {return fail(error);}
});
