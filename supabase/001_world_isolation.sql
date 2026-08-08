-- supabase/001_world_isolation.sql
--
-- Run this in the Supabase dashboard: SQL Editor > New query > paste > Run.
--
-- Two problems it fixes, both live right now:
--
--   1. Everyone shares one world. Four pipelines are writing into a single
--      undivided table, so a teammate testing locally drops mountains into the
--      world you are about to demo.
--
--   2. The publishable key can DELETE and UPDATE any row. That key ships in the
--      client bundle, so it is public. Anyone who opens devtools during judging
--      can wipe the world. Verified against the live table: DELETE returned 204,
--      not a permissions error.
--
-- Safe to re-run. Every statement is idempotent.

/* ------------------------------------------------------- 1. the world column --- */

-- Existing rows become part of 'main', which is what the demo will use.
alter table public.world_assets
  add column if not exists world text not null default 'main';

-- Every query filters on this, so it earns an index.
create index if not exists world_assets_world_idx
  on public.world_assets (world);

-- Belt and braces: a null or empty world would be invisible to every client.
alter table public.world_assets
  drop constraint if exists world_assets_world_nonempty;
alter table public.world_assets
  add constraint world_assets_world_nonempty check (length(world) > 0);


/* ---------------------------------------------- 2. adopt the orphaned rows --- */

-- A teammate's generator wrote type='animal'; this codebase reads 'creature'.
-- Same columns, same sketch format, different string — so these 12 rows are
-- sitting in the table rendering for nobody. One rename adopts them.
--
-- DELETE the next statement instead of running it if you would rather those
-- rows stay invisible.
update public.world_assets
  set type = 'creature'
  where type = 'animal';


/* -------------------------------------------------------- 3. lock it down --- */

alter table public.world_assets enable row level security;

-- Drop first so re-running this file doesn't error on an existing policy.
drop policy if exists "anyone can read the world"     on public.world_assets;
drop policy if exists "anyone can contribute"         on public.world_assets;
drop policy if exists "nobody can delete"             on public.world_assets;
drop policy if exists "nobody can update"             on public.world_assets;

-- Read and contribute: open, because that is the whole point of the project.
create policy "anyone can read the world"
  on public.world_assets for select
  using (true);

create policy "anyone can contribute"
  on public.world_assets for insert
  with check (true);

-- No UPDATE and no DELETE policy is deliberate. Under RLS, an operation with no
-- policy is denied — so leaving these out is what makes the world append-only,
-- which is exactly the contract's additive law enforced at the database instead
-- of by convention. Clear test rows from the dashboard, where you are the
-- service role and RLS does not apply.


/* --------------------------------------------------------------- 4. verify --- */

-- Expect: every row in 'main', creature count 23 (11 yours + 12 adopted).
select world, type, count(*)
  from public.world_assets
 group by world, type
 order by world, type;
