create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Generate separate capabilities in the database. Never copy secret values into migrations.
do $$ declare key_name text; begin
  foreach key_name in array array['PROXY_TOKEN','IMPORT_TOKEN','WORKER_TOKEN','SESSION_ENCRYPTION_KEY'] loop
    if not exists(select 1 from vault.secrets where name='knightro_'||key_name) then
      perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'knightro_'||key_name);
    end if;
  end loop;
  if not exists(select 1 from vault.secrets where name='knightro_PUBLIC_ORIGIN') then
    perform vault.create_secret('https://knightro-tracker-frontend-teal.vercel.app','knightro_PUBLIC_ORIGIN');
  end if;
  if not exists(select 1 from vault.secrets where name='knightro_PROJECT_URL') then
    perform vault.create_secret('https://uetdvbrfqmjbusivudam.supabase.co','knightro_PROJECT_URL');
  end if;
end $$;

-- Maintenance only: no recurring scraper or event import job is installed.
select cron.schedule('knightro-maintenance','* * * * *', $job$
  select net.http_post(
    url:=(select decrypted_secret from vault.decrypted_secrets where name='knightro_PROJECT_URL')||'/functions/v1/knightro-worker',
    headers:=jsonb_build_object('Content-Type','application/json','X-Knightro-Worker-Token',
      (select decrypted_secret from vault.decrypted_secrets where name='knightro_WORKER_TOKEN')),
    body:='{}'::jsonb,timeout_milliseconds:=85000
  );
$job$);
