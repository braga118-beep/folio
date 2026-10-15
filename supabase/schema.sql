-- Folio database schema for Supabase.
-- Run this once in your Supabase project: Dashboard > SQL Editor > New query > paste > Run.

create extension if not exists pgcrypto;

-- Your companies (you can have several)
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  email text, phone text, website text, address text, license_no text, tax_id text,
  logo text,                                   -- stored as a small data URL
  color text default '#1F4E46',
  invoice_prefix text default 'INV-',
  estimate_prefix text default 'EST-',
  next_invoice_no int default 1,
  next_estimate_no int default 1,
  tax_rate numeric default 0,
  payment_terms_days int default 30,
  estimate_valid_days int default 30,
  default_notes text, default_terms text, payment_instructions text,
  created_at timestamptz default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  email text, phone text, address text, notes text,
  created_at timestamptz default now()
);

-- Estimates and invoices
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  company_id uuid not null references public.companies on delete cascade,
  customer_id uuid references public.customers on delete set null,
  type text not null check (type in ('estimate', 'invoice')),
  number text,
  status text not null default 'draft',        -- draft | sent | accepted | declined | converted
  issue_date date,
  due_date date,                               -- invoice due date, or estimate valid-until date
  customer_name text, customer_email text, customer_phone text, customer_address text,
  job_title text, job_site text,
  items jsonb not null default '[]'::jsonb,    -- [{kind, description, qty, price, taxable}]
  tax_rate numeric default 0,
  discount_type text default 'percent',
  discount_value numeric default 0,
  notes text, terms text,
  total numeric default 0,
  amount_paid numeric default 0,
  public_token text not null unique default encode(gen_random_bytes(18), 'hex'),
  sent_at timestamptz, last_sent_at timestamptz,
  viewed_at timestamptz, view_count int not null default 0,
  accepted_at timestamptz, accepted_by text,
  archived boolean not null default false,
  source_id uuid, converted_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists documents_owner_idx on public.documents (owner, type, issue_date desc);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  document_id uuid not null references public.documents on delete cascade,
  amount numeric not null,
  paid_on date default current_date,
  method text, reference text, note text,
  created_at timestamptz default now()
);

-- Activity and notifications: sent, viewed, accepted, reminder, paid
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  document_id uuid not null references public.documents on delete cascade,
  kind text not null,
  detail text,
  seen boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists events_owner_idx on public.events (owner, created_at desc);

-- Row level security: every user only sees their own rows
alter table public.companies enable row level security;
alter table public.customers enable row level security;
alter table public.documents enable row level security;
alter table public.payments  enable row level security;
alter table public.events    enable row level security;

drop policy if exists "own rows" on public.companies;
drop policy if exists "own rows" on public.customers;
drop policy if exists "own rows" on public.documents;
drop policy if exists "own rows" on public.payments;
drop policy if exists "own rows" on public.events;
create policy "own rows" on public.companies for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own rows" on public.customers for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own rows" on public.documents for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own rows" on public.payments  for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "own rows" on public.events    for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

-- Customer page: load a document by its private link and record the view.
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
    -- one notification per 30 minutes, so refreshing the page doesn't spam you
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
    'company', to_jsonb(c) - 'owner' - 'next_invoice_no' - 'next_estimate_no'
  );
end;
$$;

-- Customer page: accept an estimate.
create or replace function public.accept_estimate(p_token text, p_name text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents;
begin
  update public.documents
    set status = 'accepted', accepted_at = now(), accepted_by = left(coalesce(nullif(trim(p_name), ''), customer_name), 120)
    where public_token = p_token and type = 'estimate' and status = 'sent' and archived = false
    returning * into d;
  if not found then
    return false;
  end if;
  insert into public.events (owner, document_id, kind, detail) values (d.owner, d.id, 'accepted', d.accepted_by);
  return true;
end;
$$;

revoke all on function public.get_public_document(text, boolean) from public;
revoke all on function public.accept_estimate(text, text) from public;
grant execute on function public.get_public_document(text, boolean) to anon, authenticated;
grant execute on function public.accept_estimate(text, text) to anon, authenticated;

-- Live notifications in the app
do $$
begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.documents;
exception when duplicate_object then null;
end $$;
