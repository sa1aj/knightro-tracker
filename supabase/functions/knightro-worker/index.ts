import webpush from 'npm:web-push@3.6.7';
import {APIError,clearConfig,config,fail,json,randomToken,requireSecret,rpc,supabase} from '../_shared/backend.ts';
Deno.serve(async req=> {
  let lease:string|null=null;
  try {
    if(req.method!=='POST') throw new APIError(405,'Method not allowed.');
    await requireSecret(req,'x-knightro-worker-token','WORKER_TOKEN');
    lease=randomToken();
    if(!(await rpc('worker/lease',null,{key:'maintenance',token:lease})).acquired) return json({ok:true,busy:true});
    await rpc('worker/tick');
    let settings=await config();
    if(!settings.VAPID_PUBLIC_KEY) {await rpc('backend/vapid',null,webpush.generateVAPIDKeys());clearConfig();settings=await config();}
    const photos=await rpc('worker/photos');
    let removed=0;
    if(photos.length) {
      const response=await supabase('/storage/v1/object/knightro-photos',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:photos.map((p:any)=>p.path)})});
      if(response.ok) for(const photo of photos) {await rpc('worker/photo-deleted',null,{id:photo.id});removed++;}
    }
    let delivered=0;
    if(settings.VAPID_PUBLIC_KEY&&settings.VAPID_PRIVATE_KEY) {
      const jobs=await rpc('worker/push');
      for(const job of jobs) {
        let status=503;
        try {
          await webpush.sendNotification(job.subscription,JSON.stringify({title:'Knight-Sense',body:job.message,alertId:job.alertId,expiresAt:job.expires,url:'/'}),
            {vapidDetails:{subject:settings.PUBLIC_ORIGIN,publicKey:settings.VAPID_PUBLIC_KEY,privateKey:settings.VAPID_PRIVATE_KEY},TTL:900,timeout:4000});
          status=201;delivered++;
        } catch(error) {status=Number((error as any)?.statusCode)||503;}
        await rpc('worker/push-result',null,{alertId:job.alertId,endpoint:job.endpoint,status});
      }
    }
    return json({ok:true,photosRemoved:removed,pushDelivered:delivered});
  } catch(error) {return fail(error);}
  finally {if(lease) try {await rpc('worker/release',null,{key:'maintenance',token:lease});} catch {/* lease expires after 120 seconds */}}
});
