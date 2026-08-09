-- supabase/001_world_isolation_ROLLBACK.sql
--
-- Undoes 001_world_isolation.sql. Run in: SQL Editor > New query > paste > Run.
--
-- Nothing here can lose a contribution. The forward migration only ADDED a
-- column and CHANGED a type string — it never deleted a row, so there is
-- nothing to restore, only things to remove.
--
-- Run this whole file to go all the way back, or run one section if only one
-- thing is in your way. Section 1 alone unblocks a demo in seconds.

/* ------------------------------------------- 1. EMERGENCY: unlock writes --- */
--
-- Run THIS ALONE if the world has gone read-only mid-demo and you need people
-- contributing again right now. Turning RLS off restores the old behaviour
-- exactly: the publishable key can insert, and also delete, as before.

alter table public.world_assets disable row level security;


/* -------------------------------------------------- 2. drop the policies --- */
--
-- Only needed if you want a clean slate before re-running the migration.
-- Harmless to skip — policies do nothing while RLS is disabled.

drop policy if exists "anyone can read the world" on public.world_assets;
drop policy if exists "anyone can contribute"     on public.world_assets;


/* ------------------------------------------------- 3. drop the world column --- */
--
-- Only run this if you are also reverting the client code (git revert 3b38b62).
-- The app sends `world` on every insert now, so dropping the column while the
-- new code is deployed breaks contributions with PGRST204.
--
-- Rows are untouched — dropping a column cannot delete a row.

drop index if exists world_assets_world_idx;

alter table public.world_assets
  drop constraint if exists world_assets_world_nonempty;

alter table public.world_assets
  drop column if exists world;


/* ------------------------------------------ 4. un-adopt the animal rows --- */
--
-- Puts the 12 renamed rows back to type='animal'.
--
-- Almost certainly NOT what you want: as 'animal' they are invisible to every
-- client, which is the bug the rename fixed. Only useful if a teammate's code
-- is still reading 'animal' and you would rather change the data than their
-- code. Left commented so a careless full-file run doesn't re-break them.
--
-- update public.world_assets set type = 'animal' where type = 'creature';


/* --------------------------------------------------------------- verify --- */

select
  (select count(*) from public.world_assets)                          as total_rows,
  (select relrowsecurity from pg_class
    where oid = 'public.world_assets'::regclass)                      as rls_enabled,
  (select count(*) from information_schema.columns
    where table_name = 'world_assets' and column_name = 'world')      as world_column_exists;
