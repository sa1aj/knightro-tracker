import {Data} from './backend.ts';

// Fixed deployment origin: never forward the gateway secret to a client URL.
const endpoint='https://knightro-tracker-frontend-teal.vercel.app/internal/photo-check';
export async function checkPhoto(photo:Uint8Array,settings:Data):Promise<Data> {
  const unavailable={status:'unavailable',reason:'checker-unavailable'};
  try {
    const response=await fetch(endpoint,{method:'POST',redirect:'error',
      headers:{'Content-Type':'image/jpeg','X-Knightro-Proxy-Token':settings.PROXY_TOKEN},
      body:new Uint8Array(photo),signal:AbortSignal.timeout(8000)});
    if(!response.ok) return unavailable;
    const value=await response.json();
    if(!['detected','review'].includes(value.status) || !Number.isFinite(value.score) || value.score<0 || value.score>1
      || !Number.isFinite(value.threshold) || value.threshold<.5 || value.threshold>1
      || !/^[a-f0-9]{40}$/.test(value.modelRevision||'') || !/^[a-f0-9]{64}$/.test(value.modelHash||'')
      || value.status!==(value.score>=value.threshold?'detected':'review')) return unavailable;
    return {status:value.status,score:value.score,threshold:value.threshold,
      modelRevision:value.modelRevision,modelHash:value.modelHash,checkedAt:Math.floor(Date.now()/1000)};
  } catch { return unavailable; }
}
