-- Change today's area without replacing its bounty ID or resetting daily claims.
-- Preserve the existing photo gate/history and all other application operations.
alter function public.kt_rpc(text,uuid,jsonb) rename to rpc_before_bounty_area;
alter function public.rpc_before_bounty_area(text,uuid,jsonb) set schema knightro;
revoke all on function knightro.rpc_before_bounty_area(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function knightro.rpc_before_bounty_area(text,uuid,jsonb) to service_role;

create unique index audit_bounty_request on knightro.audit(admin_id,(detail->>'requestId'))
  where action='bounty-area';

create function public.kt_rpc(action text,actor uuid default null,payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  n bigint:=extract(epoch from now())::bigint;
  a knightro.admins; b knightro.bounties; next_sector jsonb; old_sector jsonb;
  result jsonb; previous jsonb; intent jsonb; options jsonb; place jsonb;
begin
  if action in ('GET admin/bounties','POST admin/bounties') then
    if actor is null or not exists(select 1 from knightro.profiles where id=actor) then
      return jsonb_build_object('error','Sign in with your UCF account.','httpStatus',401);
    end if;
    select * into a from knightro.admins where user_id=actor;
    if a.user_id is null or not a.mode then
      return jsonb_build_object('error','Admin Mode is required to change bounty areas.','httpStatus',403);
    end if;
    if action='GET admin/bounties' then
      result:=knightro.rpc_before_bounty_area('GET game',actor,'{}'::jsonb);
      select coalesce(jsonb_agg(jsonb_build_object('campus',value->>'campus',
        'sectorId',value->>'sectorId','sectorName',value->>'sectorName')
        order by value->>'campus',value->>'sectorName'),'[]'::jsonb) into options
        from knightro.map_data,jsonb_array_elements(data) where id='sectors';
      return jsonb_build_object('bounties',result->'bounties','areas',options,'serverTime',n);
    end if;
    if payload->'confirm' is distinct from 'true'::jsonb
      or coalesce(payload->>'mode','') not in ('set','reroll')
      or coalesce(payload->>'campus','') not in ('main','downtown')
      or coalesce(payload->>'requestId','') !~ '^[A-Za-z0-9-]{8,64}$'
      or coalesce(payload->>'bountyId','') !~ '^[0-9a-fA-F-]{36}$'
      or coalesce(payload->>'currentSectorId','') !~ '^[a-z0-9-]{1,80}$' then
      return jsonb_build_object('error','Choose and confirm a valid bounty change.','httpStatus',400);
    end if;

    -- Serialize rerolls and their idempotency records for this campus.
    perform pg_advisory_xact_lock(hashtextextended('knightro:bounty:'||(payload->>'campus'),0));
    intent:=jsonb_build_object('campus',payload->>'campus','mode',payload->>'mode',
      'sectorId',case when payload->>'mode'='set' then payload->>'sectorId' else null end);
    select au.detail into previous from knightro.audit au where au.admin_id=actor and au.action='bounty-area'
      and au.detail->>'requestId'=payload->>'requestId';
    if previous is not null then
      if previous->'intent' is distinct from intent then
        return jsonb_build_object('error','This request ID belongs to another bounty change.','httpStatus',409);
      end if;
      return previous->'result'||jsonb_build_object('duplicate',true);
    end if;
    perform knightro.tick();
    select * into b from knightro.bounties where campus=payload->>'campus'
      and starts<=n and expires>n for update;
    if b.id is null then
      return jsonb_build_object('error','This campus has no active bounty.','httpStatus',404);
    end if;
    if b.id::text<>payload->>'bountyId' or b.sector->>'sectorId'<>payload->>'currentSectorId' then
      return jsonb_build_object('error','The bounty changed. Refresh its areas and try again.','httpStatus',409);
    end if;
    old_sector:=b.sector;
    if payload->>'mode'='reroll' then
      select value into next_sector from knightro.map_data,jsonb_array_elements(data)
        where id='sectors' and value->>'campus'=b.campus
        and value->>'sectorId'<>old_sector->>'sectorId' order by random() limit 1;
    else
      select value into next_sector from knightro.map_data,jsonb_array_elements(data)
        where id='sectors' and value->>'campus'=b.campus
        and value->>'sectorId'=payload->>'sectorId'
        and value->>'sectorId'<>old_sector->>'sectorId' limit 1;
    end if;
    if next_sector is null then
      return jsonb_build_object('error','Choose a different configured area. This campus may have only one.','httpStatus',400);
    end if;
    update knightro.bounties set sector=next_sector where id=b.id;
    result:=jsonb_build_object('ok',true,'bounty',next_sector||jsonb_build_object(
      'bountyId',b.id,'startsAt',b.starts,'expiresAt',b.expires,'multiplier',2),
      'previousSectorId',old_sector->>'sectorId','duplicate',false);
    insert into knightro.audit(admin_id,action,detail,created) values(actor,'bounty-area',
      jsonb_build_object('requestId',payload->>'requestId','intent',intent,'mode',payload->>'mode',
        'campus',b.campus,'bountyId',b.id,'before',old_sector->>'sectorName',
        'after',next_sector->>'sectorName','result',result),n);
    return result;
  end if;

  if action='POST sightings' then
    -- A submission and an area change cannot use conflicting versions of one bounty.
    -- Its existing reward/claim checks still run inside the preserved RPC.
    place:=knightro.location((payload->>'lat')::float8,(payload->>'long')::float8);
    perform 1 from knightro.bounties where campus=place->>'campus' and starts<=n and expires>n for share;
  end if;
  return knightro.rpc_before_bounty_area(action,actor,payload);
end $$;
revoke all on function public.kt_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kt_rpc(text,uuid,jsonb) to service_role;
