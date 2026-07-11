-- One-time setup for the route planner's cloud storage.
-- Run in: Supabase dashboard -> SQL Editor -> New query -> paste -> Run.

create table if not exists public.app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row Level Security: every account can only ever see and edit ITS OWN row.
alter table public.app_state enable row level security;

create policy "read own state" on public.app_state
  for select using (auth.uid() = user_id);

create policy "create own state" on public.app_state
  for insert with check (auth.uid() = user_id);

create policy "update own state" on public.app_state
  for update using (auth.uid() = user_id);
