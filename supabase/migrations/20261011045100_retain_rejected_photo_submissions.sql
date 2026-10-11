-- Retain classifier non-matches privately for admin history; never award points.
create or replace function public.kt_rpc(action text,actor uuid default null,payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; s knightro.sightings; p knightro.profiles;
  n bigint:=extract(epoch from now())::bigint; check_result jsonb; item jsonb; u knightro.uploads; place jsonb;
begin
  if action='photo/reject' then
    -- Match submission/removal lock order: account, then immutable upload.
    select * into p from knightro.profiles where id=actor for update;
    if p.id is null then return jsonb_build_object('error','Sign in with your UCF account.','httpStatus',401); end if;
    select * into s from knightro.sightings where id=(payload->>'id')::uuid;
    if s.id is not null then
      if s.user_id=actor and s.status='rejected' then
        return jsonb_build_object('ok',true,'duplicate',true);
      end if;
      return jsonb_build_object('error','Report ID already used. Retake your photo.','httpStatus',409);
    end if;
    check_result:=payload->'photoCheck';
    if jsonb_typeof(check_result) is distinct from 'object'
      or coalesce(check_result->>'status','')<>'not-detected'
      or jsonb_typeof(check_result->'score') is distinct from 'number'
      or jsonb_typeof(check_result->'threshold') is distinct from 'number' then
      return jsonb_build_object('error','The photo check could not be recorded. Please retry.','httpStatus',503);
    end if;
    if (check_result->>'score')::numeric not between 0 and 1
      or (check_result->>'threshold')::numeric not between 0.5 and 1
      or (check_result->>'score')::numeric>=(check_result->>'threshold')::numeric then
      return jsonb_build_object('error','The photo check could not be recorded. Please retry.','httpStatus',503);
    end if;
    -- This internal service action records an already validated upload attempt,
    -- even if its capture expires during inference. It never creates public data.
    select * into u from knightro.uploads where id=(payload->>'id')::uuid and user_id=actor for update;
    if u.id is null or u.created<n-600 or u.published then
      return jsonb_build_object('error','Photo upload expired. Retake your photo.','httpStatus',400);
    end if;
    place:=knightro.location((payload->>'lat')::float8,(payload->>'long')::float8);
    if place is null then return jsonb_build_object('error','Choose a valid campus location.','httpStatus',400); end if;
    insert into knightro.sightings(id,user_id,lat,lng,caption,timestamp,campus,label,photo_path,status,points,candidate_points,photo_check)
      values(u.id,actor,(payload->>'lat')::float8,(payload->>'long')::float8,
        trim(coalesce(payload->>'caption','')),n,place->>'campus',place,u.path,'rejected',0,0,
        check_result||jsonb_build_object('decision','automatic-reject'));
    -- 'published' means retained/committed here, not publicly readable.
    -- Existing cleanup keeps committed photos for 24 hours and clears photo_path.
    update knightro.uploads set published=true where id=u.id;
    return jsonb_build_object('ok',true);
  elsif action in ('sighting/existing','POST sightings') then
    select * into s from knightro.sightings where id=(payload->>'id')::uuid and user_id=actor;
    if s.id is not null then
      if s.status='rejected' and s.photo_check->>'status' in ('not-detected','review') then
        return jsonb_build_object('error','Knightro was not detected in this photo. Retake it with Knightro clearly in frame.','httpStatus',422);
      end if;
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
      from (select * from knightro.sightings where timestamp>n-86400
        and (coalesce(payload->>'status','all')='all'
          or (payload->>'status'='accepted' and status in ('published','confirmed'))
          or (payload->>'status'='rejected' and status='rejected'))
        order by timestamp desc limit 100) q;
    result:=jsonb_set(result,'{sightings}',item);
  end if;
  return result;
exception when invalid_text_representation or check_violation or numeric_value_out_of_range then
  return jsonb_build_object('error','Invalid request values.','httpStatus',400);
end $$;
revoke all on function public.kt_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kt_rpc(text,uuid,jsonb) to service_role;


create index sightings_rejected_photos on knightro.sightings(timestamp desc) where status='rejected';
