-- Folio upgrade 1: price book, deposits and payment schedules, photos.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Safe to run more than once. Your existing data is kept.

-- Payment schedules
alter table public.companies add column if not exists use_schedule boolean not null default false;
alter table public.companies add column if not exists default_schedule jsonb not null default '[]'::jsonb;
alter table public.documents add column if not exists schedule jsonb not null default '[]'::jsonb;
alter table public.documents add column if not exists milestone_index int;
alter table public.documents add column if not exists milestone_name text;
alter table public.documents add column if not exists show_photos boolean not null default true;

-- Price book
create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  company_id uuid references public.companies on delete cascade,   -- empty = all companies
  name text not null,
  kind text,
  unit text,
  price numeric default 0,
  description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Photos on estimates and invoices
create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  document_id uuid not null references public.documents on delete cascade,
  path text,
  url text not null,
  caption text,
  position int default 0,
  width int,
  height int,
  created_at timestamptz default now()
);
create index if not exists photos_doc_idx on public.photos (document_id, position);

alter table public.items  enable row level security;
alter table public.photos enable row level security;
drop policy if exists "own rows" on public.items;
drop policy if exists "own rows" on public.photos;
create policy "own rows" on public.items  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own rows" on public.photos for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- Photo storage. Files are stored under a random name in a folder per user;
-- anyone with the exact link can view a photo, which is how your customer sees them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "folio photos upload" on storage.objects;
drop policy if exists "folio photos delete" on storage.objects;
create policy "folio photos upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "folio photos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- Customer page now also returns the photos (when "Show photos to the customer" is on).
create or replace function public.get_public_document(p_token text, p_record boolean default true)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents;
  c public.companies;
begin
  select * into d from public.documents where public_token = p_token and archived = false;
  if not found then
    return null;
  end if;

  if p_record and d.status <> 'draft' then
    update public.documents
      set viewed_at = coalesce(viewed_at, now()), view_count = view_count + 1
      where id = d.id
      returning * into d;
    if not exists (
      select 1 from public.events
      where document_id = d.id and kind = 'viewed' and created_at > now() - interval '30 minutes'
    ) then
      insert into public.events (owner, document_id, kind) values (d.owner, d.id, 'viewed');
    end if;
  end if;

  select * into c from public.companies where id = d.company_id;
  return json_build_object(
    'document', to_jsonb(d) - 'owner',
    'company', to_jsonb(c) - 'owner' - 'next_invoice_no' - 'next_estimate_no',
    'photos', case when d.show_photos then (
      select coalesce(json_agg(json_build_object('url', p.url, 'caption', p.caption) order by p.position, p.created_at), '[]'::json)
      from public.photos p where p.document_id = d.id
    ) else '[]'::json end
  );
end;
$$;

revoke all on function public.get_public_document(text, boolean) from public;
grant execute on function public.get_public_document(text, boolean) to anon, authenticated;
