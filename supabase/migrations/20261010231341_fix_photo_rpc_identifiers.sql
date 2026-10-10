-- Qualify local variables with their declared block, rather than the function parameter block.
CREATE OR REPLACE FUNCTION public.kt_rpc(action text, actor uuid DEFAULT NULL::uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
#variable_conflict use_column
<<request_state>>
declare n bigint:=extract(epoch from now())::bigint; p knightro.profiles; a knightro.admins; s knightro.sightings;
  u knightro.uploads; result jsonb; label jsonb; item jsonb; b knightro.bounties;
  id uuid; target uuid; amount integer; remaining bigint; count_rows integer; count_events integer;
  raw text; key_text text; current_count integer; rate knightro.rate_limits; lease knightro.leases;
begin
  if action='backend/config' then return knightro.config();
  elsif action='backend/vapid' then perform knightro.save_vapid(payload); return jsonb_build_object('ok',true);
  elsif action='rate' then
    key_text:=payload->>'key'; perform pg_advisory_xact_lock(hashtextextended(key_text,0));
    select * into rate from knightro.rate_limits where key=key_text;
    if rate.key is null or rate.started<=n-(payload->>'window')::int then
      insert into knightro.rate_limits values(key_text,n,1) on conflict(key) do update set started=n,count=1;
      return jsonb_build_object('allowed',true);
    end if;
    if rate.count >= (payload->>'limit')::int then return jsonb_build_object('allowed',false,'retryAfter',rate.started+(payload->>'window')::int-n); end if;
    update knightro.rate_limits set count=count+1 where key=key_text; return jsonb_build_object('allowed',true);
  elsif action='session/create' then
    insert into knightro.sessions(token_hash,user_id,box,expires) values(payload->>'hash',actor,payload->>'box',n+14*86400);
    -- Bounded server-side sessions per account; old browser sessions retire.
    delete from knightro.sessions where user_id=actor and token_hash not in (select token_hash from knightro.sessions where user_id=actor order by expires desc limit 10);
    return jsonb_build_object('ok',true);
  elsif action='session/get' then
    select jsonb_build_object('userId',user_id,'box',box) into result from knightro.sessions where token_hash=payload->>'hash' and expires>n;
    return coalesce(result,'null'::jsonb);
  elsif action='session/update' then
    update knightro.sessions set box=payload->>'box' where token_hash=payload->>'hash' and user_id=actor and expires>n;
    return jsonb_build_object('ok',found);
  elsif action='session/delete' then
    delete from knightro.sessions where token_hash=payload->>'hash'; return jsonb_build_object('ok',true);
  elsif action='events/import' then
    perform pg_advisory_xact_lock(71831003);
    select jsonb_build_object('generatedAt',generated,'hash',snapshot_hash) into result from knightro.event_feed where id;
    if (payload->>'generatedAt')::bigint>n+300 then return jsonb_build_object('error','Snapshot time is in the future.','httpStatus',400); end if;
    if result is not null and (payload->>'generatedAt')::bigint<(result->>'generatedAt')::bigint then return jsonb_build_object('error','A newer scraper snapshot is already imported.','httpStatus',409); end if;
    if result->>'hash'=payload->>'hash' then return jsonb_build_object('ok',true,'duplicate',true); end if;
    insert into knightro.event_feed(id,events,raw_events,generated,imported,snapshot_hash) values(true,payload->'events',payload->'rawEvents',(payload->>'generatedAt')::bigint,n,payload->>'hash')
      on conflict(id) do update set events=excluded.events,raw_events=excluded.raw_events,generated=excluded.generated,imported=n,snapshot_hash=excluded.snapshot_hash;
    return jsonb_build_object('ok',true,'eventCount',jsonb_array_length(payload->'events'),'generatedAt',payload->'generatedAt');
  elsif action='worker/lease' then
    key_text:=payload->>'key'; perform pg_advisory_xact_lock(hashtextextended(key_text,0));
    select * into lease from knightro.leases where key=key_text;
    if lease.expires>n then return jsonb_build_object('acquired',false); end if;
    insert into knightro.leases values(key_text,payload->>'token',n+120) on conflict(key) do update set token=excluded.token,expires=excluded.expires;
    return jsonb_build_object('acquired',true);
  elsif action='worker/release' then
    delete from knightro.leases where key=payload->>'key' and token=payload->>'token'; return jsonb_build_object('ok',true);
  elsif action='worker/tick' then
    perform knightro.tick(); return jsonb_build_object('ok',true);
  elsif action='worker/photos' then
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'path',path)),'[]') into result from
      (select id,path from knightro.uploads where created<n-case when published then 86400 else 600 end order by created limit 100) q;
    return result;
  elsif action='worker/photo-deleted' then
    id:=(payload->>'id')::uuid;
    select * into u from knightro.uploads where uploads.id=request_state.id for update;
    if u.created>=n-(case when u.published then 86400 else 600 end) then return jsonb_build_object('ok',false); end if;
    update knightro.sightings set photo_path=null where sightings.id=request_state.id;
    delete from knightro.uploads where uploads.id=request_state.id; return jsonb_build_object('ok',true);
  elsif action='worker/push' then
    select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (
      select j.alert_id as "alertId",j.endpoint,j.attempts,a.message,a.expires,su.payload as subscription
      from knightro.push_jobs j join knightro.alerts a on a.id=j.alert_id join knightro.subscriptions su on su.endpoint=j.endpoint
      where not j.sent and j.attempts<5 and j.next_try<=n and a.expires>n order by a.created limit 15 for update of j skip locked
    ) q;
    for item in select value from jsonb_array_elements(result) loop
      update knightro.push_jobs set attempts=attempts+1,next_try=n+120 where alert_id=(item->>'alertId')::uuid and endpoint=item->>'endpoint';
    end loop;
    return result;
  elsif action='worker/push-result' then
    if (payload->>'status')::int in (404,410) then delete from knightro.subscriptions where endpoint=payload->>'endpoint';
    elsif (payload->>'status')::int between 200 and 299 then update knightro.push_jobs set sent=true where alert_id=(payload->>'alertId')::uuid and endpoint=payload->>'endpoint';
    else update knightro.push_jobs set next_try=n+least(900,30*power(2,attempts)::int) where alert_id=(payload->>'alertId')::uuid and endpoint=payload->>'endpoint'; end if;
    return jsonb_build_object('ok',true);
  end if;

  if actor is not null then
    select * into p from knightro.profiles where profiles.id=actor for update;
    select * into a from knightro.admins where user_id=actor;
  end if;
  if action='GET auth/session' then
    result:=jsonb_build_object('user',case when p.id is null then null else jsonb_build_object('id',p.id,'displayName',p.name,
      'email',p.email,'score',knightro.score(p.id),'emailVerified',false) end,
      'nextSightingAt',case when p.id is null or (a.mode and a.bypass) then 0 else p.last_post+120 end,
      'cooldownSeconds',120,'authMode','password','emailDelivery','disabled','accounts',true);
    if a.user_id is not null then result:=result||jsonb_build_object('admin',jsonb_build_object('allowed',true,'mode',a.mode,'bypassCooldown',a.mode and a.bypass)); end if;
    return result;
  elsif action='GET sightings' then
    select coalesce(jsonb_agg(knightro.sighting_out(q::knightro.sightings)),'[]') into result from
      (select * from knightro.sightings where timestamp>n-1200 and status in ('published','confirmed') order by timestamp desc limit 500) q;
    return jsonb_build_object('sightings',result);
  elsif action='GET leaderboard' then
    select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (
      select id,name as "displayName",knightro.score(id) as score from knightro.profiles
      where exists(select 1 from knightro.sightings where user_id=profiles.id and status in ('published','confirmed'))
         or exists(select 1 from knightro.adjustments where user_id=profiles.id)
      order by score desc,created,id limit 50) q;
    return jsonb_build_object('leaders',result,'period','all-time');
  elsif action='GET events' then
    select jsonb_build_object('events',coalesce((select jsonb_agg(value) from jsonb_array_elements(events)
      where (value->>'endsAt')::bigint>n and (value->>'startsAt')::bigint<n+14*86400),'[]'),
      'available',true,'generatedAt',generated,'importedAt',imported,'stale',generated<n-7*86400,'filter','likely-knightro')
      into result from knightro.event_feed where id;
    return coalesce(result,jsonb_build_object('events','[]'::jsonb,'available',false,'generatedAt',null));
  elsif action='GET game' then
    perform knightro.tick();
    select coalesce(jsonb_agg(sector||jsonb_build_object('bountyId',id,'startsAt',starts,'expiresAt',expires,'multiplier',2)),'[]') into result from knightro.bounties where starts<=n and expires>n;
    return jsonb_build_object('bounties',result,'alerts',(select coalesce(jsonb_agg(jsonb_build_object('alertId',id,'message',message,'reason',reason,'campus',campus,'createdAt',created,'expiresAt',expires)),'[]') from knightro.alerts where expires>n),'serverTime',n);
  elsif action='GET photo' then
    select * into s from knightro.sightings where sightings.id=(payload->>'id')::uuid;
    if s.photo_path is null or (s.status not in ('published','confirmed') and actor is distinct from s.user_id and a.user_id is null) then return jsonb_build_object('error','Photo not found.','httpStatus',404); end if;
    return jsonb_build_object('path',s.photo_path);
  end if;
  if p.id is null then return jsonb_build_object('error','Sign in with your UCF account.','httpStatus',401); end if;
  if action='sighting/existing' then
    select * into s from knightro.sightings where sightings.id=(payload->>'id')::uuid and user_id=actor and status in ('published','confirmed','rejected');
    if s.id is not null then return knightro.sighting_out(s)||jsonb_build_object('nextSightingAt',p.last_post+120,'duplicate',true); end if;
    return 'null'::jsonb;
  elsif action='GET my-reports' then
    select coalesce(jsonb_agg(knightro.sighting_out(q::knightro.sightings)),'[]') into result from (select * from knightro.sightings where user_id=actor order by timestamp desc limit 30) q;
    return jsonb_build_object('reports',result);
  elsif action='POST camera-session' or action='photo/reserve' or action='POST sightings' then
    if action='POST sightings' then
      select * into s from knightro.sightings where sightings.id=(payload->>'id')::uuid and user_id=actor;
      if s.id is not null then return knightro.sighting_out(s)||jsonb_build_object('nextSightingAt',p.last_post+120,'duplicate',true); end if;
    end if;
    remaining:=case when a.mode and a.bypass then 0 else p.last_post+120-n end;
    if remaining>0 then return jsonb_build_object('error','Please wait before another sighting.','httpStatus',429,'retryAfter',remaining); end if;
    if action='POST camera-session' then
      insert into knightro.camera_tokens values(actor,payload->>'hash',n+120) on conflict(user_id) do update set token_hash=excluded.token_hash,expires=excluded.expires;
      return jsonb_build_object('expiresAt',n+120);
    end if;
    if not exists(select 1 from knightro.camera_tokens where user_id=actor and token_hash=payload->>'captureHash' and expires>n) then
      return jsonb_build_object('error','Take a fresh camera photo before submitting.','httpStatus',400);
    end if;
    label:=knightro.location((payload->>'lat')::float8,(payload->>'long')::float8);
    if label is null then return jsonb_build_object('error','Choose a location on Main, Rosen, or Downtown campus.','httpStatus',400); end if;
    if action='photo/reserve' then
      perform pg_advisory_xact_lock(71831004);
      if coalesce((select sum(bytes) from knightro.uploads),0)+(payload->>'bytes')::int>750000000 then return jsonb_build_object('error','Photo storage is full. Try again after cleanup.','httpStatus',503); end if;
      id:=(payload->>'id')::uuid;
      insert into knightro.uploads values(id,actor,actor::text||'/'||id::text||'.jpg',(payload->>'bytes')::int,n,false) on conflict do nothing;
      select * into u from knightro.uploads where uploads.id=request_state.id;
      if u.user_id<>actor then return jsonb_build_object('error','Report ID already used.','httpStatus',409); end if;
      return jsonb_build_object('path',u.path);
    end if;
    id:=(payload->>'id')::uuid;
    select * into u from knightro.uploads where uploads.id=request_state.id and user_id=actor for update;
    if u.id is null or u.created<n-120 then return jsonb_build_object('error','Photo upload expired. Retake your photo.','httpStatus',400); end if;
    perform knightro.tick();
    select * into b from knightro.bounties where starts<=n and expires>n and knightro.inside((payload->>'lat')::float8,(payload->>'long')::float8,sector->'area')
      and not exists(select 1 from knightro.sightings where user_id=actor and bounty_id=bounties.id and status in ('published','confirmed')) limit 1;
    insert into knightro.sightings(id,user_id,lat,lng,caption,timestamp,campus,label,photo_path,status,points,bounty_id,candidate_points)
      values(id,actor,(payload->>'lat')::float8,(payload->>'long')::float8,trim(coalesce(payload->>'caption','')),n,label->>'campus',label,u.path,'published',case when b.id is null then 1 else 2 end,b.id,case when b.id is null then 1 else 2 end) returning * into s;
    update knightro.uploads set published=true where uploads.id=request_state.id;
    update knightro.profiles set last_post=n where profiles.id=actor;
    delete from knightro.camera_tokens where user_id=actor;
    return knightro.sighting_out(s)||jsonb_build_object('nextSightingAt',case when a.mode and a.bypass then n else n+120 end);
  elsif action='POST presence' then
    label:=knightro.location((payload->>'lat')::float8,(payload->>'long')::float8);
    if label->>'buildingId' is null then return jsonb_build_object('ok',true); end if;
    if exists(select 1 from knightro.presence where user_id=actor and opened>n-60) then return jsonb_build_object('ok',true); end if;
    insert into knightro.presence values(actor,label->>'buildingId',n) on conflict(user_id) do update set building_id=excluded.building_id,opened=n;
    if (select count(*) from knightro.presence where building_id=label->>'buildingId' and opened>n-300)>=6
      and (select count(*) from knightro.presence where building_id=label->>'buildingId' and opened between n-600 and n-300)<=2 then
      select value into item from jsonb_array_elements((select data from knightro.map_data where id='buildings')) where value->>'id'=label->>'buildingId';
      perform knightro.add_alert(item,'Sudden cluster of app openings; unconfirmed mascot activity','cluster:'||(label->>'buildingId')||':'||(n/900)::text,n);
    end if;
    return jsonb_build_object('ok',true);
  elsif action='POST push/subscribe' then
    if (select count(*) from knightro.subscriptions where user_id=actor)>=5 and not exists(select 1 from knightro.subscriptions where endpoint=payload->'subscription'->>'endpoint' and user_id=actor) then
      return jsonb_build_object('error','Maximum five push subscriptions per account.','httpStatus',400);
    end if;
    insert into knightro.subscriptions values(payload->'subscription'->>'endpoint',actor,payload->'subscription',n)
      on conflict(endpoint) do update set user_id=actor,payload=excluded.payload,updated=n;
    return jsonb_build_object('ok',true);
  elsif action='POST push/unsubscribe' then
    delete from knightro.subscriptions where endpoint=payload->>'endpoint' and user_id=actor; return jsonb_build_object('ok',true);
  end if;

  if a.user_id is null then return jsonb_build_object('error','Admin access is limited to authorized accounts.','httpStatus',403); end if;
  if action='GET admin/state' then return jsonb_build_object('mode',a.mode,'bypassCooldown',a.mode and a.bypass); end if;
  if action='POST admin/mode' then
    update knightro.admins set mode=(payload->>'enabled')::boolean,bypass=case when (payload->>'enabled')::boolean then bypass else false end where user_id=actor;
  else
    if not a.mode then return jsonb_build_object('error','Turn on Admin Mode to use admin tools.','httpStatus',403); end if;
    if action='GET admin/users' then
      select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (select pr.id,pr.name as "displayName",pr.email,knightro.score(pr.id) as score
      from knightro.profiles pr where position(lower(payload->>'q') in lower(pr.name))>0 or position(lower(payload->>'q') in lower(pr.email))>0 order by pr.name limit 20) q;
      return jsonb_build_object('users',result);
    elsif action='GET admin/sightings' then
      select coalesce(jsonb_agg(knightro.sighting_out(q::knightro.sightings)||jsonb_build_object('displayName',(select name from knightro.profiles where profiles.id=q.user_id))),'[]') into result
      from (select * from knightro.sightings where timestamp>n-86400 order by timestamp desc limit 60) q;
      return jsonb_build_object('sightings',result);
    elsif action='GET admin/test-sightings' then
      select coalesce(jsonb_agg(knightro.sighting_out(q::knightro.sightings)),'[]') into result from (select * from knightro.sightings where status='test' and timestamp>n-1200) q;
      return jsonb_build_object('sightings',result);
    elsif action='GET admin/test-events' then
      select coalesce(jsonb_agg(data),'[]') into result from knightro.test_events where (data->>'endsAt')::bigint>n;
      return jsonb_build_object('events',result);
    elsif action='GET admin/log' then
      select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (select au.id,au.action,au.detail,au.created,pr.name as "adminName",pr.email as "adminEmail"
      from knightro.audit au left join knightro.profiles pr on pr.id=au.admin_id order by au.id desc limit 50) q;
      return jsonb_build_object('entries',result);
    elsif action='POST admin/cooldown' then
      update knightro.admins set bypass=(payload->>'enabled')::boolean where user_id=actor;
    elsif action='POST admin/points' then
      target:=(payload->>'userId')::uuid; amount:=(payload->>'amount')::int;
      perform 1 from knightro.profiles where profiles.id=target for update;
      if not found then return jsonb_build_object('error','User not found.','httpStatus',404); end if;
      if exists(select 1 from knightro.adjustments where request_id=payload->>'requestId') then
        if not exists(select 1 from knightro.adjustments where request_id=payload->>'requestId' and admin_id=actor and user_id=target and adjustments.amount=request_state.amount and reason=payload->>'reason') then return jsonb_build_object('error','Request ID already used.','httpStatus',409); end if;
        return jsonb_build_object('ok',true,'duplicate',true,'userId',target,'score',knightro.score(target));
      end if;
      if knightro.score(target)+amount<0 then return jsonb_build_object('error','A deduction cannot go below zero.','httpStatus',400); end if;
      insert into knightro.adjustments values(payload->>'requestId',target,amount,payload->>'reason',actor,n);
      result:=jsonb_build_object('ok',true,'userId',target,'score',knightro.score(target));
    elsif action='POST admin/test-events' then
      label:=knightro.location((payload->>'lat')::float8,(payload->>'long')::float8);
      if label is null then return jsonb_build_object('error','Choose a campus location.','httpStatus',400); end if;
      if payload ? 'eventId' then
        id:=replace(payload->>'eventId','test-','')::uuid;
        if not exists(select 1 from knightro.test_events where test_events.id=request_state.id) then return jsonb_build_object('error','Test event not found.','httpStatus',404); end if;
      else id:=gen_random_uuid(); end if;
      item:=payload||label||jsonb_build_object('eventId','test-'||id::text,'isTest',true,'hosts',jsonb_build_array('Admin test'),'url',null,'probability',1,'reason','Admin test event');
      insert into knightro.test_events values(id,item) on conflict(id) do update set data=excluded.data;
      result:=jsonb_build_object('ok',true,'event',item);
    elsif action='POST admin/test-events/delete' then
      delete from knightro.test_events where test_events.id=replace(payload->>'eventId','test-','')::uuid; result:=jsonb_build_object('ok',true);
    elsif action='POST admin/test-sightings' then
      label:=knightro.location((payload->>'lat')::float8,(payload->>'long')::float8);
      if label is null then return jsonb_build_object('error','Choose a campus location.','httpStatus',400); end if;
      id:=gen_random_uuid();
      insert into knightro.sightings(id,user_id,lat,lng,caption,timestamp,campus,label,status,points,candidate_points)
      values(id,actor,(payload->>'lat')::float8,(payload->>'long')::float8,coalesce(payload->>'caption',''),n,label->>'campus',label,'test',0,0) returning * into s;
      result:=jsonb_build_object('ok',true,'sighting',knightro.sighting_out(s));
    elsif action='POST admin/sightings/remove' then
      id:=(payload->>'sightingId')::uuid;
      select * into s from knightro.sightings where sightings.id=request_state.id;
      if s.id is null then return jsonb_build_object('error','Sighting not found.','httpStatus',404); end if;
      -- Lock score owner so point deductions and moderation serialize with posts.
      perform 1 from knightro.profiles where profiles.id=s.user_id for update;
      select * into s from knightro.sightings where sightings.id=request_state.id for update;
      update knightro.sightings set status='rejected',points=0 where sightings.id=request_state.id;
      result:=jsonb_build_object('ok',true,'status','rejected');
    elsif action='POST admin/test-data/clear' then
      delete from knightro.test_events; get diagnostics count_events=row_count;
      delete from knightro.sightings where status='test'; get diagnostics count_rows=row_count;
      result:=jsonb_build_object('ok',true,'testEvents',count_events,'testSightings',count_rows);
    else return jsonb_build_object('error','API route not found.','httpStatus',404);
    end if;
  end if;
  insert into knightro.audit(admin_id,action,detail,created) values(actor,action,payload,n);
  if result is not null then return result; end if;
  select * into a from knightro.admins where user_id=actor;
  return jsonb_build_object('mode',a.mode,'bypassCooldown',a.mode and a.bypass);
exception when invalid_text_representation or check_violation or numeric_value_out_of_range then
  return jsonb_build_object('error','Invalid request values.','httpStatus',400);
end $function$
;
