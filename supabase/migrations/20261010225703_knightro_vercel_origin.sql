-- Canonical production frontend after the authorized Vercel redeployment.
select vault.update_secret(id, 'https://knightro-tracker-potatogigabyte.vercel.app')
from vault.secrets where name = 'knightro_PUBLIC_ORIGIN';
