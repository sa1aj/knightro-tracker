-- Admin demo data: one switchable set of demo events and one of demo sightings, for testing the map and lists.
-- Each set is identified by its row in knightro.demo_sets (kind) and the exact record IDs stored there, never by
-- title text, so turning a set off touches only that tool's records. Real events, manual test events and real
-- sightings are never read or changed by these operations.
--
-- Rules:
-- - Only admins with Admin Mode on can read or change the sets (checked here; every change is audited).
-- - Enabled and visibility are separate. A disabled set has no records at all, so nothing can leak whatever its
--   saved visibility. "Admins only" (the default) is enforced by the queries below, not by the browser.
-- - Demo events are ordinary admin test events (isTest, never award points), stored with the existing
--   'visible' flag so the public events feed already filters them (20261011080000_test_event_visibility.sql).
-- - Demo sightings live in their own table, never in knightro.sightings, so they cannot reach points, bounty
--   claims, the leaderboard, alerts or any probability calculation. They have no photo.
-- - Re-enabling reuses the same record IDs (no duplicates) and refreshes event dates into the upcoming week.

create table knightro.demo_sets (
  kind text primary key check (kind in ('events','sightings')),
  enabled boolean not null default false,
  visible boolean not null default false,
  campus text not null default 'main' check (campus in ('main','downtown')),
  ids uuid[] not null default '{}',
  generated bigint, updated bigint,
  updated_by uuid references knightro.profiles(id) on delete set null
);
insert into knightro.demo_sets(kind) values ('events'),('sightings');
create table knightro.demo_sightings (id uuid primary key, data jsonb not null);
alter table knightro.demo_sets enable row level security;
alter table knightro.demo_sightings enable row level security;
grant select,insert,update,delete on knightro.demo_sets, knightro.demo_sightings to service_role;

-- A demo sighting as the API returns it. Times stay recent while the set is on: each record keeps a fixed age
-- (its offset), so the route between spots always reads as a plausible walk.
create function knightro.demo_sighting_out(d jsonb, n bigint) returns jsonb language sql stable set search_path='' as $$
  select (d - 'offset') || jsonb_build_object('timestamp', n - (d->>'offset')::bigint);
$$;

create function knightro.demo_state() returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'campuses', jsonb_build_array('main','downtown'),
    'events', (select jsonb_build_object('enabled',enabled,'visible',visible,'campus',campus,'generatedAt',generated,
      'count',(select count(*) from knightro.test_events t where t.id = any(s.ids)))
      from knightro.demo_sets s where kind='events'),
    'sightings', (select jsonb_build_object('enabled',enabled,'visible',visible,'campus',campus,'generatedAt',generated,
      'count',(select count(*) from knightro.demo_sightings t where t.id = any(s.ids)))
      from knightro.demo_sets s where kind='sightings'));
$$;

-- Venues are mapped buildings (knightro.map_data). Days are counted from today in Orlando, so all three
-- events fall inside the map's rolling 7-day window and in the future.
create function knightro.demo_events_spec(campus text) returns jsonb language sql immutable set search_path='' as $$
  select case campus
    when 'main' then '[
      {"building":"52","title":"Knightro Spirit Rally (Test)","day":1,"start":"12:00","minutes":60,
       "description":"Demo event for testing the map. Pep rally on the Student Union plaza with the spirit team."},
      {"building":"50","title":"Knights Basketball Watch Party (Test)","day":2,"start":"18:30","minutes":120,
       "description":"Demo event for testing the map. Watch party in the Addition Financial Arena concourse."},
      {"building":"memorymall","title":"Memory Mall Photo Walk (Test)","day":3,"start":"16:00","minutes":90,
       "description":"Demo event for testing the map. Photo walk across Memory Mall; meet at the south plaza."}]'::jsonb
    else '[
      {"building":"dr-phillips-academic-commons","title":"Downtown Spirit Hour (Test)","day":1,"start":"12:00","minutes":60,
       "description":"Demo event for testing the map. Spirit hour in the Dr. Phillips Academic Commons lobby."},
      {"building":"906","title":"FIEA Game Night (Test)","day":2,"start":"18:00","minutes":120,
       "description":"Demo event for testing the map. Game night at the Florida Interactive Entertainment Academy."},
      {"building":"dr-phillips-academic-commons","title":"Downtown Study Break (Test)","day":3,"start":"15:00","minutes":60,
       "description":"Demo event for testing the map. Study break in the Dr. Phillips Academic Commons courtyard."}]'::jsonb
  end;
$$;

-- Outdoor public spots checked against the OpenStreetMap base map (plazas, footpaths, lawns; no roofs, roads or
-- water). 5 decimal places is about 1 m, more than the map can show. Offsets are seconds before "now", ordered
-- as a walk at an easy pace (about 30-60 m per minute), all inside the 20-minute sighting window.
create function knightro.demo_sightings_spec(campus text) returns jsonb language sql immutable set search_path='' as $$
  select case campus
    when 'main' then '[
      {"lat":28.59996,"long":-81.20159,"offset":1020,"caption":"Walking the path by the Reflecting Pond (demo)"},
      {"lat":28.60142,"long":-81.20100,"offset":660,"caption":"High-fives on the Student Union south plaza (demo)"},
      {"lat":28.60358,"long":-81.19942,"offset":360,"caption":"At the Veterans Commemorative Site plaza (demo)"},
      {"lat":28.60476,"long":-81.19877,"offset":120,"caption":"Posing for photos on Memory Mall (demo)"}]'::jsonb
    else '[
      {"lat":28.54860,"long":-81.38641,"offset":540,"caption":"Crossing Luminary Green (demo)"},
      {"lat":28.54705,"long":-81.38515,"offset":180,"caption":"In the UCF Downtown courtyard (demo)"}]'::jsonb
  end;
$$;

-- Create or refresh one set in place, reusing its stored IDs. Returns the IDs now in use.
create function knightro.demo_generate(set_kind text, campus text, visible boolean, ids uuid[], n bigint)
returns uuid[] language plpgsql set search_path='' as $$
declare spec jsonb; item jsonb; b jsonb; label jsonb; i int; rid uuid; out_ids uuid[]:='{}';
  today date:=(now() at time zone 'America/New_York')::date; starts bigint;
begin
  spec:=case set_kind when 'events' then knightro.demo_events_spec(campus) else knightro.demo_sightings_spec(campus) end;
  for i in 0..jsonb_array_length(spec)-1 loop
    item:=spec->i;
    rid:=coalesce(ids[i+1], gen_random_uuid());
    out_ids:=out_ids||rid;
    if set_kind='events' then
      select value into b from knightro.map_data, jsonb_array_elements(data)
        where id='buildings' and value->>'id'=item->>'building' limit 1;
      if b is null then raise exception 'Demo venue % is missing from the map data', item->>'building'; end if;
      starts:=extract(epoch from ((today + (item->>'day')::int) + (item->>'start')::time) at time zone 'America/New_York')::bigint;
      insert into knightro.test_events(id,data) values (rid, jsonb_build_object(
        'eventId','test-'||rid::text,'title',item->>'title','description',item->>'description',
        'location',b->>'name','lat',(b->>'lat')::float8,'long',(b->>'long')::float8,
        'buildingId',b->>'id','buildingName',b->>'name','campus',b->>'campus',
        'startsAt',starts,'endsAt',starts+(item->>'minutes')::int*60,
        'isTest',true,'visible',visible,'demo','demo-events','hosts',jsonb_build_array('Admin demo events'),
        'url',null,'probability',1,'reason','Admin demo event'))
      on conflict (id) do update set data=excluded.data;
    else
      label:=knightro.location((item->>'lat')::float8,(item->>'long')::float8);
      if label is null then raise exception 'Demo sighting % is outside the campus map', i; end if;
      insert into knightro.demo_sightings(id,data) values (rid, label||jsonb_build_object(
        'sightingId',rid,'lat',(item->>'lat')::float8,'long',(item->>'long')::float8,'caption',item->>'caption',
        'offset',(item->>'offset')::int,'status','test','points',0,'eligiblePoints',0,'bountyId',null,
        'photoUrl',null,'isTest',true,'isDemo',true,'visible',visible,'demo','demo-sightings'))
      on conflict (id) do update set data=excluded.data;
    end if;
  end loop;
  -- A smaller spec (e.g. after switching campus) removes this set's leftover records only.
  if set_kind='events' then
    delete from knightro.test_events where id = any(ids) and not (id = any(out_ids));
  else
    delete from knightro.demo_sightings where id = any(ids) and not (id = any(out_ids));
  end if;
  return out_ids;
end $$;

-- Preserve the existing application RPC and add the demo routes and filters around it.
alter function public.kt_rpc(text,uuid,jsonb) rename to rpc_before_demo_data;
alter function public.rpc_before_demo_data(text,uuid,jsonb) set schema knightro;
revoke all on function knightro.rpc_before_demo_data(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function knightro.rpc_before_demo_data(text,uuid,jsonb) to service_role;
revoke all on function knightro.demo_generate(text,text,boolean,uuid[],bigint), knightro.demo_state(),
  knightro.demo_sighting_out(jsonb,bigint), knightro.demo_events_spec(text), knightro.demo_sightings_spec(text)
  from public,anon,authenticated;
grant execute on function knightro.demo_generate(text,text,boolean,uuid[],bigint), knightro.demo_state(),
  knightro.demo_sighting_out(jsonb,bigint), knightro.demo_events_spec(text), knightro.demo_sightings_spec(text)
  to service_role;

create function public.kt_rpc(action text,actor uuid default null,payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare n bigint:=extract(epoch from now())::bigint; a knightro.admins; s knightro.demo_sets;
  result jsonb; extra jsonb; want_enabled boolean; want_visible boolean; want_campus text; new_ids uuid[];
begin
  if action in ('GET admin/demo','POST admin/demo') then
    if actor is null or not exists(select 1 from knightro.profiles where id=actor) then
      return jsonb_build_object('error','Sign in with your UCF account.','httpStatus',401);
    end if;
    select * into a from knightro.admins where user_id=actor;
    if a.user_id is null then return jsonb_build_object('error','Admin access is limited to authorized accounts.','httpStatus',403); end if;
    if not a.mode then return jsonb_build_object('error','Turn on Admin Mode to use admin tools.','httpStatus',403); end if;
    if action='GET admin/demo' then return knightro.demo_state(); end if;

    if coalesce(payload->>'kind','') not in ('events','sightings')
      or (payload ? 'enabled' and jsonb_typeof(payload->'enabled')<>'boolean')
      or (payload ? 'visible' and jsonb_typeof(payload->'visible')<>'boolean')
      or (payload ? 'campus' and coalesce(payload->>'campus','') not in ('main','downtown')) then
      return jsonb_build_object('error','Choose a valid demo data setting.','httpStatus',400);
    end if;
    -- One change at a time per set: repeated or simultaneous clicks cannot create a second copy.
    select * into s from knightro.demo_sets where kind=payload->>'kind' for update;
    want_enabled:=coalesce((payload->>'enabled')::boolean, s.enabled);
    want_visible:=coalesce((payload->>'visible')::boolean, s.visible);
    want_campus:=coalesce(payload->>'campus', s.campus);
    new_ids:=s.ids;
    if want_enabled then
      new_ids:=knightro.demo_generate(s.kind, want_campus, want_visible, s.ids, n);
    elsif s.kind='events' then
      delete from knightro.test_events where id = any(s.ids);
    else
      delete from knightro.demo_sightings where id = any(s.ids);
    end if;
    update knightro.demo_sets set enabled=want_enabled, visible=want_visible, campus=want_campus, ids=new_ids,
      generated=case when want_enabled then n else generated end, updated=n, updated_by=actor where kind=s.kind;
    insert into knightro.audit(admin_id,action,detail,created) values(actor,'demo-'||s.kind,
      jsonb_build_object('enabled',want_enabled,'visible',want_visible,'campus',want_campus,'count',
        case when want_enabled then coalesce(array_length(new_ids,1),0) else 0 end),n);
    return knightro.demo_state()||jsonb_build_object('ok',true);
  end if;

  -- Demo events are managed only through their toggle, so a stray edit or delete cannot desync the set.
  if action in ('POST admin/test-events','POST admin/test-events/delete')
    and coalesce(payload->>'eventId','') ~ '^test-[0-9a-fA-F-]{36}$'
    and exists(select 1 from knightro.demo_sets where kind='events'
      and substr(payload->>'eventId',6)::uuid = any(ids)) then
    return jsonb_build_object('error','This event belongs to Demo Events. Use the Demo Events controls instead.','httpStatus',409);
  end if;

  result:=knightro.rpc_before_demo_data(action,actor,payload);
  if result ? 'error' then return result; end if;

  if action='GET sightings' then
    -- Regular users: only an enabled set marked visible (a disabled set has no rows).
    select coalesce(jsonb_agg(knightro.demo_sighting_out(d.data,n)),'[]'::jsonb) into extra
      from knightro.demo_sightings d join knightro.demo_sets s2 on s2.kind='sightings'
      where s2.enabled and s2.visible and d.id = any(s2.ids);
    result:=jsonb_set(result,'{sightings}',coalesce(result->'sightings','[]'::jsonb)||extra);
  elsif action='GET admin/test-sightings' then
    -- Admins in Admin Mode (already checked by the wrapped function) see the set whatever its visibility.
    select coalesce(jsonb_agg(knightro.demo_sighting_out(d.data,n)),'[]'::jsonb) into extra
      from knightro.demo_sightings d join knightro.demo_sets s2 on s2.kind='sightings'
      where s2.enabled and d.id = any(s2.ids);
    result:=jsonb_set(result,'{sightings}',coalesce(result->'sightings','[]'::jsonb)||extra);
  elsif action='POST admin/test-data/clear' then
    -- Clearing test data removes every test event (demo ones included), so both demo sets switch off with it.
    delete from knightro.demo_sightings;
    update knightro.demo_sets set enabled=false, updated=n, updated_by=actor where enabled;
    result:=result||jsonb_build_object('demoSetsDisabled',true);
  end if;
  return result;
end $$;
revoke all on function public.kt_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kt_rpc(text,uuid,jsonb) to service_role;
