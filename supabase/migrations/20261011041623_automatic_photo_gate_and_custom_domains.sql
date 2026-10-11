-- Keep exact-origin CSRF protection while allowing the project's custom domains.
do $$
declare secret_id uuid; origins jsonb;
begin
  select id, decrypted_secret::jsonb into secret_id,origins
    from vault.decrypted_secrets where name='knightro_PUBLIC_ORIGINS';
  select jsonb_agg(distinct value) into origins from jsonb_array_elements_text(
    coalesce(origins,'[]'::jsonb)||jsonb_build_array('https://knightro.photo','https://www.knightro.photo')) value;
  if secret_id is null then
    perform vault.create_secret(origins::text,'knightro_PUBLIC_ORIGINS');
  else
    perform vault.update_secret(secret_id,origins::text);
  end if;
end $$;

-- Only server-verified matches create reports. No manual approval path remains.
create or replace function public.kt_rpc(action text,actor uuid default null,payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; s knightro.sightings; p knightro.profiles;
  n bigint:=extract(epoch from now())::bigint; check_result jsonb; item jsonb;
begin
  if action in ('sighting/existing','POST sightings') then
    select * into s from knightro.sightings where id=(payload->>'id')::uuid and user_id=actor;
    if s.id is not null then
      if s.status not in ('published','confirmed') then
        return jsonb_build_object('error','This report is not published. Take a new photo with Knightro clearly in frame.','httpStatus',409);
      end if;
      select * into p from knightro.profiles where id=actor;
      return knightro.sighting_out(s)||jsonb_build_object('nextSightingAt',p.last_post+120,'duplicate',true);
    end if;
    if action='sighting/existing' then return 'null'::jsonb; end if;
    check_result:=payload->'photoCheck';
    if jsonb_typeof(check_result) is distinct from 'object'
      or coalesce(check_result->>'status','') not in ('detected','not-detected','review') then
      return jsonb_build_object('error','The photo checker is temporarily unavailable. Your sighting was not posted. Please retry.','httpStatus',503);
    end if;
    if check_result->>'status'<>'detected' then
      return jsonb_build_object('error','Knightro was not detected in this photo. Retake it with Knightro clearly in frame.','httpStatus',422);
    end if;
    if jsonb_typeof(check_result->'score') is distinct from 'number'
      or jsonb_typeof(check_result->'threshold') is distinct from 'number' then
      return jsonb_build_object('error','The photo check could not be verified. Please retry.','httpStatus',503);
    end if;
    if (check_result->>'score')::numeric not between 0 and 1
      or (check_result->>'threshold')::numeric not between 0.5 and 1
      or (check_result->>'score')::numeric<(check_result->>'threshold')::numeric then
      return jsonb_build_object('error','The photo check could not be verified. Please retry.','httpStatus',503);
    end if;
  elsif action='POST admin/sightings/approve' then
    return jsonb_build_object('error','Manual photo approval is disabled. Sightings require a detected Knightro photo.','httpStatus',410);
  end if;

  result:=knightro.rpc_before_photo_review(action,actor,payload);
  if result ? 'httpStatus' then return result; end if;
  if action='POST sightings' and not coalesce((result->>'duplicate')::boolean,false) then
    update knightro.sightings set photo_check=check_result||jsonb_build_object('decision','automatic-publish')
      where id=(payload->>'id')::uuid and user_id=actor;
  elsif action='POST admin/sightings/remove' then
    update knightro.sightings set photo_check=coalesce(photo_check,'{}'::jsonb)||
      jsonb_build_object('reviewedAt',n,'reviewedBy',actor,'decision','removed')
      where id=(payload->>'sightingId')::uuid;
  elsif action='GET my-reports' then
    select coalesce(jsonb_agg(value||jsonb_build_object('photoCheck',sightings.photo_check)),'[]'::jsonb) into item
      from jsonb_array_elements(result->'reports') value left join knightro.sightings
      on sightings.id=(value->>'sightingId')::uuid;
    result:=jsonb_set(result,'{reports}',item);
  elsif action='GET admin/sightings' then
    select coalesce(jsonb_agg(knightro.sighting_out(q::knightro.sightings)||
      jsonb_build_object('photoCheck',q.photo_check,'displayName',(select name from knightro.profiles where id=q.user_id))
      order by q.timestamp desc),'[]'::jsonb) into item
      from (select * from knightro.sightings where timestamp>n-86400 order by timestamp desc limit 100) q;
    result:=jsonb_set(result,'{sightings}',item);
  end if;
  return result;
exception when invalid_text_representation or check_violation or numeric_value_out_of_range then
  return jsonb_build_object('error','Invalid request values.','httpStatus',400);
end $$;
revoke all on function public.kt_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kt_rpc(text,uuid,jsonb) to service_role;

-- Previously queued non-matches stay private and worth zero points.
update knightro.sightings set status='rejected',points=0,
  photo_check=coalesce(photo_check,'{}'::jsonb)||jsonb_build_object('decision','automatic-not-published')
  where status='pending';
alter table knightro.sightings drop constraint sightings_status_check;
alter table knightro.sightings add constraint sightings_status_check
  check(status in ('published','confirmed','rejected','test'));
drop index knightro.sightings_pending_review;
comment on column knightro.sightings.photo_check is 'Server-produced automatic Knightro classification and removal metadata; never accepted from browser fields.';
