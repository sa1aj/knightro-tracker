-- Service-only photo moderation. Existing reports retain their status and points.
alter table knightro.sightings drop constraint sightings_status_check;
alter table knightro.sightings add constraint sightings_status_check
  check(status in ('published','confirmed','pending','rejected','test'));
alter table knightro.sightings add column photo_check jsonb;
create index sightings_pending_review on knightro.sightings(timestamp desc) where status='pending';

-- Preserve the existing application RPC and wrap only photo submission/review.
alter function public.kt_rpc(text,uuid,jsonb) rename to rpc_before_photo_review;
alter function public.rpc_before_photo_review(text,uuid,jsonb) set schema knightro;
revoke all on function knightro.rpc_before_photo_review(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function knightro.rpc_before_photo_review(text,uuid,jsonb) to service_role;

create function public.kt_rpc(action text,actor uuid default null,payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; s knightro.sightings; a knightro.admins; p knightro.profiles;
  n bigint:=extract(epoch from now())::bigint; awarded integer; check_result jsonb; item jsonb;
begin
  if action='sighting/existing' then
    select * into s from knightro.sightings where id=(payload->>'id')::uuid and user_id=actor;
    if s.id is not null then
      select * into p from knightro.profiles where id=actor;
      return knightro.sighting_out(s)||jsonb_build_object('nextSightingAt',p.last_post+120,'duplicate',true);
    end if;
    return 'null'::jsonb;
  elsif action='POST admin/sightings/approve' then
    if not coalesce((payload->>'confirm')::boolean,false) then
      return jsonb_build_object('error','Confirm photo approval.','httpStatus',400);
    end if;
    select * into a from knightro.admins where user_id=actor;
    if a.user_id is null or not a.mode then
      return jsonb_build_object('error','Turn on authorized Admin Mode to review photos.','httpStatus',403);
    end if;
    select * into s from knightro.sightings where id=(payload->>'sightingId')::uuid;
    if s.id is null then return jsonb_build_object('error','Report not found.','httpStatus',404); end if;
    -- Match submission/removal lock order: score owner first, report second.
    perform 1 from knightro.profiles where id=s.user_id for update;
    select * into s from knightro.sightings where id=(payload->>'sightingId')::uuid for update;
    if s.status='confirmed' then return jsonb_build_object('ok',true,'duplicate',true,'status',s.status); end if;
    if s.status<>'pending' or s.photo_path is null then
      return jsonb_build_object('error','This photo is not awaiting review or has expired.','httpStatus',409);
    end if;
    awarded:=s.candidate_points;
    if s.bounty_id is not null and exists(select 1 from knightro.sightings
      where user_id=s.user_id and bounty_id=s.bounty_id and status in ('published','confirmed') and id<>s.id) then
      awarded:=1;
      -- The existing unique bounty claim index must continue to protect double awards.
      update knightro.sightings set bounty_id=null where id=s.id;
    end if;
    update knightro.sightings set status='confirmed',points=awarded,
      photo_check=coalesce(photo_check,'{}'::jsonb)||jsonb_build_object('reviewedAt',n,'reviewedBy',actor,'decision','approved')
      where id=s.id;
    insert into knightro.audit(admin_id,action,detail,created) values(actor,action,payload,n);
    return jsonb_build_object('ok',true,'status','confirmed','points',awarded);
  end if;

  result:=knightro.rpc_before_photo_review(action,actor,payload);
  if result ? 'httpStatus' then return result; end if;
  if action='POST sightings' and not coalesce((result->>'duplicate')::boolean,false) then
    check_result:=payload->'photoCheck';
    if jsonb_typeof(check_result) is distinct from 'object' or coalesce(check_result->>'status','') not in ('detected','review','unavailable') then
      check_result:=jsonb_build_object('status','unavailable','reason','check-not-available');
    end if;
    update knightro.sightings set photo_check=check_result,
      status=case when check_result->>'status'='detected' then 'published' else 'pending' end,
      points=case when check_result->>'status'='detected' then points else 0 end
      where id=(payload->>'id')::uuid and user_id=actor returning * into s;
    return knightro.sighting_out(s)||jsonb_build_object('nextSightingAt',result->'nextSightingAt');
  elsif action='POST admin/sightings/remove' then
    update knightro.sightings set photo_check=coalesce(photo_check,'{}'::jsonb)||
      jsonb_build_object('reviewedAt',n,'reviewedBy',actor,'decision','rejected')
      where id=(payload->>'sightingId')::uuid;
  elsif action in ('GET my-reports','GET admin/sightings') then
    if action='GET my-reports' then
      select coalesce(jsonb_agg(value||jsonb_build_object('photoCheck',sightings.photo_check)),'[]'::jsonb) into item
        from jsonb_array_elements(result->'reports') value left join knightro.sightings
        on sightings.id=(value->>'sightingId')::uuid;
      result:=jsonb_set(result,'{reports}',item);
    else
      -- Prioritize pending photos so public reports cannot bury the review queue.
      select coalesce(jsonb_agg(knightro.sighting_out(q::knightro.sightings)||
        jsonb_build_object('photoCheck',q.photo_check,'displayName',(select name from knightro.profiles where id=q.user_id))
        order by (q.status='pending') desc,q.timestamp desc),'[]'::jsonb) into item
        from (select * from knightro.sightings where timestamp>n-86400
          order by (status='pending') desc,timestamp desc limit 100) q;
      result:=jsonb_set(result,'{sightings}',item);
    end if;
  end if;
  return result;
exception when invalid_text_representation or check_violation or numeric_value_out_of_range then
  return jsonb_build_object('error','Invalid request values.','httpStatus',400);
end $$;
revoke all on function public.kt_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kt_rpc(text,uuid,jsonb) to service_role;
comment on column knightro.sightings.photo_check is 'Server-produced photo classification and human moderation; never accepted from browser request fields.';
