import {APIError,boundedBody,fail,hash,json,limit,requireSecret,rpc} from '../_shared/backend.ts';
import {validateFeed} from '../_shared/events.ts';
Deno.serve(async req=> {
  try {
    if(req.method!=='POST') throw new APIError(405,'Use POST to import a scraper snapshot.');
    await requireSecret(req,'x-knightro-import-token','IMPORT_TOKEN');
    await limit('manual-event-import',20,3600);
    const feed=await boundedBody(req,8000000),events=validateFeed(feed);
    const digest=await hash(JSON.stringify({events:feed.events,generatedAt:feed.generatedAt}));
    const result=await rpc('events/import',null,{events,rawEvents:feed.events,generatedAt:feed.generatedAt,hash:digest});
    return json({...result,sourceEvents:feed.events.length,likelyKnightroEvents:events.length});
  } catch(error) {return fail(error);}
});
