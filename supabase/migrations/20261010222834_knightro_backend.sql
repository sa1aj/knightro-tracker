-- Knightro application data is private. Only the authenticated Edge backend calls kt_rpc.
create schema if not exists knightro;
revoke all on schema knightro from public, anon, authenticated;
grant usage on schema knightro to service_role;
alter default privileges in schema knightro revoke execute on functions from public;

create table knightro.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 30),
  created bigint not null default extract(epoch from now())::bigint,
  last_post bigint not null default 0
);
create table knightro.admins (
  user_id uuid primary key references knightro.profiles(id) on delete cascade,
  mode boolean not null default false, bypass boolean not null default false
);
create table knightro.sessions (
  token_hash text primary key, user_id uuid not null references knightro.profiles(id) on delete cascade,
  box text not null, expires bigint not null
);
create index on knightro.sessions(expires);
create table knightro.camera_tokens (
  user_id uuid primary key references knightro.profiles(id) on delete cascade,
  token_hash text not null, expires bigint not null
);
create table knightro.map_data (id text primary key, data jsonb not null);
create table knightro.bounties (
  id uuid primary key default gen_random_uuid(), campus text not null, sector jsonb not null,
  starts bigint not null, expires bigint not null, unique(campus,starts)
);
create table knightro.uploads (
  id uuid primary key, user_id uuid not null references knightro.profiles(id) on delete cascade,
  path text unique not null, bytes integer not null check(bytes between 1 and 300000),
  created bigint not null, published boolean not null default false
);
create index on knightro.uploads(created);
create table knightro.sightings (
  id uuid primary key, user_id uuid not null references knightro.profiles(id) on delete cascade,
  lat double precision not null, lng double precision not null,
  caption text not null check(char_length(caption)<=200), timestamp bigint not null,
  campus text not null, label jsonb not null, photo_path text,
  status text not null check(status in ('published','confirmed','rejected','test')),
  points integer not null default 1, bounty_id uuid references knightro.bounties(id),
  candidate_points integer not null default 1
);
create index on knightro.sightings(timestamp desc);
create index on knightro.sightings(user_id,timestamp desc);
create unique index on knightro.sightings(user_id,bounty_id) where bounty_id is not null and status in ('published','confirmed');
create table knightro.adjustments (
  request_id text primary key, user_id uuid not null references knightro.profiles(id) on delete cascade,
  amount integer not null check(amount<>0 and abs(amount)<=1000), reason text not null,
  admin_id uuid not null references knightro.profiles(id), created bigint not null
);
create index on knightro.adjustments(user_id);
create table knightro.audit (
  id bigint generated always as identity primary key, admin_id uuid references knightro.profiles(id),
  action text not null, detail jsonb not null, created bigint not null
);
create table knightro.test_events (id uuid primary key, data jsonb not null);
create table knightro.event_feed (
  id boolean primary key default true check(id), events jsonb not null,
  raw_events jsonb not null default '[]',
  generated bigint not null, imported bigint not null, snapshot_hash text not null
);
create table knightro.presence (
  user_id uuid primary key references knightro.profiles(id) on delete cascade,
  building_id text not null, opened bigint not null
);
create index on knightro.presence(building_id,opened);
create table knightro.alerts (
  id uuid primary key default gen_random_uuid(), building_id text not null, campus text not null,
  message text not null, reason text not null, created bigint not null, expires bigint not null,
  source text unique not null
);
create index on knightro.alerts(created desc);
create table knightro.subscriptions (
  endpoint text primary key, user_id uuid not null references knightro.profiles(id) on delete cascade,
  payload jsonb not null, updated bigint not null
);
create index on knightro.subscriptions(user_id);
create table knightro.push_jobs (
  alert_id uuid references knightro.alerts(id) on delete cascade,
  endpoint text references knightro.subscriptions(endpoint) on delete cascade,
  attempts integer not null default 0, next_try bigint not null default 0, sent boolean not null default false,
  primary key(alert_id,endpoint)
);
create table knightro.rate_limits (key text primary key, started bigint not null, count integer not null);
create table knightro.leases (key text primary key, token text not null, expires bigint not null);

-- Deployment secrets are encrypted in Vault, never committed in Git.
create function knightro.config() returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if current_setting('role',true) not in ('service_role','postgres') then raise exception 'Service access required'; end if;
  return (select coalesce(jsonb_object_agg(substr(name,10),decrypted_secret),'{}') from vault.decrypted_secrets where name like 'knightro\_%');
end $$;
revoke all on function knightro.config() from public,anon,authenticated;
grant execute on function knightro.config() to service_role;
create function knightro.save_vapid(data jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
  if current_setting('role',true) <> 'service_role' then raise exception 'Service access required'; end if;
  perform pg_advisory_xact_lock(71831005);
  if not exists(select 1 from vault.secrets where name='knightro_VAPID_PUBLIC_KEY') then
    perform vault.create_secret(data->>'publicKey','knightro_VAPID_PUBLIC_KEY');
    perform vault.create_secret(data->>'privateKey','knightro_VAPID_PRIVATE_KEY');
  end if;
end $$;
revoke all on function knightro.save_vapid(jsonb) from public,anon,authenticated;
grant execute on function knightro.save_vapid(jsonb) to service_role;

-- No API-facing tables or views. Defense in depth even in the unexposed schema.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='knightro' loop
    execute format('alter table knightro.%I enable row level security',t.tablename);
  end loop;
end $$;
grant select,insert,update,delete on all tables in schema knightro to service_role;
grant usage,select on all sequences in schema knightro to service_role;

create function knightro.account_created() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_table_schema <> 'auth' or tg_table_name <> 'users' then raise exception 'Invalid account trigger'; end if;
  if new.email is null or char_length(new.email)>254 or lower(new.email) !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@(ucf\.edu|knights\.ucf\.edu)$' then
    raise exception 'Signup requires a UCF email address';
  end if;
  if tg_op='INSERT' then
    insert into knightro.profiles(id,name) values(new.id,coalesce(nullif(left(trim(new.raw_user_meta_data->>'displayName'),30),''),'Knight'));
  end if;
  return new;
end $$;
revoke all on function knightro.account_created() from public,anon,authenticated,service_role;
create trigger knightro_account_created after insert or update of email on auth.users
for each row execute function knightro.account_created();

create function knightro.inside(lat double precision,lng double precision,ring jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare i integer; j integer; a jsonb; b jsonb; hit boolean:=false;
begin
  j:=jsonb_array_length(ring)-1;
  for i in 0..jsonb_array_length(ring)-1 loop
    a:=ring->i; b:=ring->j;
    if ((a->>1)::float8>lat)<>((b->>1)::float8>lat) then
      if lng<((b->>0)::float8-(a->>0)::float8)*(lat-(a->>1)::float8)/((b->>1)::float8-(a->>1)::float8)+(a->>0)::float8 then hit:=not hit; end if;
    end if;
    j:=i;
  end loop;
  return hit;
end $$;

create function knightro.location(lat float8,lng float8) returns jsonb
language plpgsql stable set search_path='' as $$
declare c jsonb; b jsonb; best jsonb; d float8; minimum float8:=1e9; relation text:='Near'; ring jsonb;
begin
  if lat is null or lng is null or lat::text in ('NaN','Infinity','-Infinity') or lng::text in ('NaN','Infinity','-Infinity') then return null; end if;
  select value into c from jsonb_array_elements((select data from knightro.map_data where id='campuses'))
  where lat between (value->'bounds'->>'minLat')::float8 and (value->'bounds'->>'maxLat')::float8
    and lng between (value->'bounds'->>'minLng')::float8 and (value->'bounds'->>'maxLng')::float8 limit 1;
  if c is null then return null; end if;
  for b in select value from jsonb_array_elements((select data from knightro.map_data where id='buildings')) where value->>'campus'=c->>'id' loop
    d:=sqrt(power((lat-(b->>'lat')::float8)*111320,2)+power((lng-(b->>'long')::float8)*111320*cos(radians(lat)),2));
    for ring in select value from jsonb_array_elements(b->'polygons') loop
      if knightro.inside(lat,lng,ring) then best:=b; relation:='At'; exit; end if;
    end loop;
    if relation='At' then exit; end if;
    if d<minimum then minimum:=d; best:=b; end if;
  end loop;
  if relation='Near' and minimum>120 then best:=null; end if;
  return jsonb_build_object('campus',c->>'id','buildingId',best->>'id','buildingName',best->>'name',
    'placeLabel',case when best is null then c->>'name' else relation||' '||(best->>'name') end);
end $$;
create function knightro.score(uid uuid) returns bigint language sql stable set search_path='' as $$
  select coalesce((select sum(points) from knightro.sightings where user_id=uid and status in ('published','confirmed')),0)
    +coalesce((select sum(amount) from knightro.adjustments where user_id=uid),0);
$$;
create function knightro.sighting_out(s knightro.sightings) returns jsonb language sql stable set search_path='' as $$
  select s.label||jsonb_build_object('sightingId',s.id,'lat',s.lat,'long',s.lng,'caption',s.caption,'timestamp',s.timestamp,
    'campus',s.campus,'status',s.status,'points',s.points,'eligiblePoints',s.candidate_points,'bountyId',s.bounty_id,
    'photoUrl',case when s.photo_path is null then null else '/api/photos/'||s.id::text end,'isTest',s.status='test');
$$;
create function knightro.add_alert(building jsonb,reason text,source_key text,n bigint) returns void
language plpgsql set search_path='' as $$
declare aid uuid;
begin
  perform pg_advisory_xact_lock(71831002);
  if exists(select 1 from knightro.alerts where source=source_key or created>n-900 or (building_id=building->>'id' and created>n-3600)) then return; end if;
  insert into knightro.alerts(building_id,campus,message,reason,created,expires,source)
  values(building->>'id',building->>'campus','My Knight-Sense is tingling near '||(building->>'name')||'...',reason,n,n+900,source_key) returning id into aid;
  insert into knightro.push_jobs(alert_id,endpoint) select aid,endpoint from knightro.subscriptions on conflict do nothing;
end $$;
create function knightro.tick() returns void language plpgsql set search_path='' as $$
declare n bigint:=extract(epoch from now())::bigint; start_at bigint; end_at bigint; c text; sector jsonb; event jsonb; building jsonb;
begin
  start_at:=extract(epoch from (date_trunc('day',now() at time zone 'America/New_York') at time zone 'America/New_York'))::bigint;
  end_at:=extract(epoch from ((date_trunc('day',now() at time zone 'America/New_York')+interval '1 day') at time zone 'America/New_York'))::bigint;
  for c in select distinct value->>'campus' from jsonb_array_elements((select data from knightro.map_data where id='sectors')) loop
    select value into sector from jsonb_array_elements((select data from knightro.map_data where id='sectors')) where value->>'campus'=c order by random() limit 1;
    insert into knightro.bounties(campus,sector,starts,expires) values(c,sector,start_at,end_at) on conflict(campus,starts) do nothing;
  end loop;
  for event in select value from knightro.event_feed,jsonb_array_elements(events)
    where (value->>'startsAt')::bigint between n and n+900 and value ? 'buildingId' loop
    select value into building from jsonb_array_elements((select data from knightro.map_data where id='buildings')) where value->>'id'=event->>'buildingId';
    if building is not null then perform knightro.add_alert(building,event->>'reason','event:'||(event->>'eventId')||':'||(event->>'startsAt'),n); end if;
  end loop;
  delete from knightro.presence where opened<n-600;
  delete from knightro.camera_tokens where expires<n;
  delete from knightro.sessions where expires<n;
  delete from knightro.alerts where expires<n-86400;
  delete from knightro.rate_limits where started<n-86400;
  delete from knightro.audit where created<n-90*86400;
end $$;

-- Service-only RPC: invoker rights, explicit grants, no caller-supplied authorization claims.
create function public.kt_rpc(action text,actor uuid default null,payload jsonb default '{}') returns jsonb
language plpgsql security invoker set search_path='' as $$
#variable_conflict use_column
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
    select * into u from knightro.uploads where uploads.id=kt_rpc.id for update;
    if u.created>=n-(case when u.published then 86400 else 600 end) then return jsonb_build_object('ok',false); end if;
    update knightro.sightings set photo_path=null where sightings.id=kt_rpc.id;
    delete from knightro.uploads where uploads.id=kt_rpc.id; return jsonb_build_object('ok',true);
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
      'email',(select email from auth.users where users.id=p.id),'score',knightro.score(p.id),'emailVerified',false) end,
      'nextSightingAt',case when p.id is null or (a.mode and a.bypass) then 0 else p.last_post+120 end,
      'cooldownSeconds',120,'authMode','password','emailDelivery','disabled','accounts',true);
    if a.user_id is not null then result:=result||jsonb_build_object('admin',jsonb_build_object('allowed',true,'mode',a.mode,'bypassCooldown',a.mode and a.bypass)); end if;
    return result;
  elsif action='GET sightings' then
    select coalesce(jsonb_agg(knightro.sighting_out(q)),'[]') into result from
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
    select coalesce(jsonb_agg(knightro.sighting_out(q)),'[]') into result from (select * from knightro.sightings where user_id=actor order by timestamp desc limit 30) q;
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
      select * into u from knightro.uploads where uploads.id=kt_rpc.id;
      if u.user_id<>actor then return jsonb_build_object('error','Report ID already used.','httpStatus',409); end if;
      return jsonb_build_object('path',u.path);
    end if;
    id:=(payload->>'id')::uuid;
    select * into u from knightro.uploads where uploads.id=kt_rpc.id and user_id=actor for update;
    if u.id is null or u.created<n-120 then return jsonb_build_object('error','Photo upload expired. Retake your photo.','httpStatus',400); end if;
    perform knightro.tick();
    select * into b from knightro.bounties where starts<=n and expires>n and knightro.inside((payload->>'lat')::float8,(payload->>'long')::float8,sector->'area')
      and not exists(select 1 from knightro.sightings where user_id=actor and bounty_id=bounties.id and status in ('published','confirmed')) limit 1;
    insert into knightro.sightings(id,user_id,lat,lng,caption,timestamp,campus,label,photo_path,status,points,bounty_id,candidate_points)
      values(id,actor,(payload->>'lat')::float8,(payload->>'long')::float8,trim(coalesce(payload->>'caption','')),n,label->>'campus',label,u.path,'published',case when b.id is null then 1 else 2 end,b.id,case when b.id is null then 1 else 2 end) returning * into s;
    update knightro.uploads set published=true where uploads.id=kt_rpc.id;
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
      select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (select pr.id,pr.name as "displayName",au.email,knightro.score(pr.id) as score
      from knightro.profiles pr join auth.users au on au.id=pr.id where position(lower(payload->>'q') in lower(pr.name))>0 or position(lower(payload->>'q') in lower(au.email))>0 order by pr.name limit 20) q;
      return jsonb_build_object('users',result);
    elsif action='GET admin/sightings' then
      select coalesce(jsonb_agg(knightro.sighting_out(q)||jsonb_build_object('displayName',(select name from knightro.profiles where profiles.id=q.user_id))),'[]') into result
      from (select * from knightro.sightings where timestamp>n-86400 order by timestamp desc limit 60) q;
      return jsonb_build_object('sightings',result);
    elsif action='GET admin/test-sightings' then
      select coalesce(jsonb_agg(knightro.sighting_out(q)),'[]') into result from (select * from knightro.sightings where status='test' and timestamp>n-1200) q;
      return jsonb_build_object('sightings',result);
    elsif action='GET admin/test-events' then
      select coalesce(jsonb_agg(data),'[]') into result from knightro.test_events where (data->>'endsAt')::bigint>n;
      return jsonb_build_object('events',result);
    elsif action='GET admin/log' then
      select coalesce(jsonb_agg(to_jsonb(q)),'[]') into result from (select au.id,au.action,au.detail,au.created,pr.name as "adminName",u.email as "adminEmail"
      from knightro.audit au left join knightro.profiles pr on pr.id=au.admin_id left join auth.users u on u.id=pr.id order by au.id desc limit 50) q;
      return jsonb_build_object('entries',result);
    elsif action='POST admin/cooldown' then
      update knightro.admins set bypass=(payload->>'enabled')::boolean where user_id=actor;
    elsif action='POST admin/points' then
      target:=(payload->>'userId')::uuid; amount:=(payload->>'amount')::int;
      perform 1 from knightro.profiles where profiles.id=target for update;
      if not found then return jsonb_build_object('error','User not found.','httpStatus',404); end if;
      if exists(select 1 from knightro.adjustments where request_id=payload->>'requestId') then
        if not exists(select 1 from knightro.adjustments where request_id=payload->>'requestId' and admin_id=actor and user_id=target and adjustments.amount=kt_rpc.amount and reason=payload->>'reason') then return jsonb_build_object('error','Request ID already used.','httpStatus',409); end if;
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
        if not exists(select 1 from knightro.test_events where test_events.id=kt_rpc.id) then return jsonb_build_object('error','Test event not found.','httpStatus',404); end if;
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
      select * into s from knightro.sightings where sightings.id=kt_rpc.id;
      if s.id is null then return jsonb_build_object('error','Sighting not found.','httpStatus',404); end if;
      -- Lock score owner so point deductions and moderation serialize with posts.
      perform 1 from knightro.profiles where profiles.id=s.user_id for update;
      select * into s from knightro.sightings where sightings.id=kt_rpc.id for update;
      update knightro.sightings set status='rejected',points=0 where sightings.id=kt_rpc.id;
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
end $$;
revoke all on function public.kt_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kt_rpc(text,uuid,jsonb) to service_role;
grant execute on all functions in schema knightro to service_role;
revoke execute on function knightro.account_created() from service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('knightro-photos','knightro-photos',false,300000,array['image/jpeg'])
on conflict(id) do nothing;
-- Storage has no anon/authenticated policies for this private bucket. Edge functions mediate access.
