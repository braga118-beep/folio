-- Folio upgrade 2: jobs, change orders, and customers choosing options on estimates.
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run upgrade-1.sql first if you haven't. Safe to run more than once; your data is kept.

-- Jobs group an estimate, its change orders and invoices, payments and photos.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  company_id uuid references public.companies on delete cascade,
  customer_id uuid references public.customers on delete set null,
  name text not null,
  address text,
  status text not null default 'estimating',   -- estimating | active | on_hold | completed
  notes text,
  created_at timestamptz default now()
);
alter table public.jobs enable row level security;
drop policy if exists "own rows" on public.jobs;
create policy "own rows" on public.jobs for all to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

alter table public.documents add column if not exists job_id uuid references public.jobs on delete set null;
alter table public.documents add column if not exists contract jsonb;     -- change orders: original contract and earlier changes
create index if not exists documents_job_idx on public.documents (job_id);

-- Change orders are a third kind of document.
alter table public.documents drop constraint if exists documents_type_check;
alter table public.documents add constraint documents_type_check check (type in ('estimate', 'invoice', 'change_order'));

alter table public.companies add column if not exists change_order_prefix text default 'CO-';
alter table public.companies add column if not exists next_change_order_no int default 1;
update public.companies set change_order_prefix = 'CO-' where change_order_prefix is null;
update public.companies set next_change_order_no = 1 where next_change_order_no is null;

-- Accepting an estimate or approving a change order, optionally with the customer's option choices.
drop function if exists public.accept_estimate(text, text);
drop function if exists public.accept_estimate(text, text, int[]);
create function public.accept_estimate(p_token text, p_name text, p_selected int[] default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents;
begin
  select * into d from public.documents
    where public_token = p_token and type in ('estimate', 'change_order') and status = 'sent' and archived = false;
  if not found then
    return false;
  end if;

  -- Only the "selected" flag of optional lines can change; prices and wording stay as written.
  if p_selected is not null then
    update public.documents set items = coalesce((
      select jsonb_agg(
        case when coalesce(e.value->>'option', '') in ('addon', 'choice')
          then e.value || jsonb_build_object('selected', (e.ordinality - 1)::int = any(p_selected))
          else e.value end
        order by e.ordinality)
      from jsonb_array_elements(d.items) with ordinality as e
    ), '[]'::jsonb)
    where id = d.id;
  end if;

  update public.documents
    set status = 'accepted', accepted_at = now(), accepted_by = left(coalesce(nullif(trim(p_name), ''), customer_name), 120)
    where id = d.id
    returning * into d;
  insert into public.events (owner, document_id, kind, detail) values (d.owner, d.id, 'accepted', d.accepted_by);
  return true;
end;
$$;

revoke all on function public.accept_estimate(text, text, int[]) from public;
grant execute on function public.accept_estimate(text, text, int[]) to anon, authenticated;
