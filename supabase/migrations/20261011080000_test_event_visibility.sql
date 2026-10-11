-- Admin test events can be shown to regular users. Hidden is the default.
-- The flag lives in test_events.data ('visible': true|false). Only the public events feed reads it:
-- hidden test events are never sent to regular users, and admin test-event routes keep their existing
-- admin + Admin Mode checks (in the wrapped function), so only authorized admins can change visibility.
-- Visible test events keep isTest=true, probability 1 and 'Admin test event'; they award no points (points
-- come only from sightings), and nothing here touches sightings, bounties or the leaderboard.

update knightro.test_events set data=data||jsonb_build_object('visible',false) where not (data ? 'visible');

-- Preserve the existing application RPC and wrap only the events feed and test-event saves.
alter function public.kt_rpc(text,uuid,jsonb) rename to rpc_before_test_visibility;
alter function public.rpc_before_test_visibility(text,uuid,jsonb) set schema knightro;
revoke all on function knightro.rpc_before_test_visibility(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function knightro.rpc_before_test_visibility(text,uuid,jsonb) to service_role;

create function public.kt_rpc(action text,actor uuid default null,payload jsonb default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; shared jsonb; n bigint:=extract(epoch from now())::bigint;
begin
  if action='POST admin/test-events' then
    -- Stored as a strict boolean whatever the request contained (the API also validates it).
    payload:=payload||jsonb_build_object('visible',coalesce(payload->'visible'='true'::jsonb,false));
  end if;
  result:=knightro.rpc_before_test_visibility(action,actor,payload);
  if action='GET events' and not (result ? 'error') then
    -- Same window as feed events: not ended, starting within 14 days. Marked as tests by their stored data.
    select coalesce(jsonb_agg(data order by (data->>'startsAt')::bigint),'[]'::jsonb) into shared
      from knightro.test_events
      where data->>'visible'='true' and (data->>'endsAt')::bigint>n and (data->>'startsAt')::bigint<n+14*86400;
    result:=jsonb_set(result,'{events}',coalesce(result->'events','[]'::jsonb)||shared);
  end if;
  return result;
end $$;
revoke all on function public.kt_rpc(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.kt_rpc(text,uuid,jsonb) to service_role;
