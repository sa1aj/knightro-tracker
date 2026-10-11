-- Both production frontends use the same private backend and existing data.
do $$
declare secret_id uuid;
begin
  select id into secret_id from vault.secrets where name = 'knightro_PUBLIC_ORIGINS';
  if secret_id is null then
    perform vault.create_secret(
      '["https://knightro-tracker-frontend-teal.vercel.app"]',
      'knightro_PUBLIC_ORIGINS'
    );
  else
    perform vault.update_secret(
      secret_id,
      '["https://knightro-tracker-frontend-teal.vercel.app"]'
    );
  end if;
end $$;
