-- Stripe is authoritative; these are account- and mode-scoped projections.
-- No client may write billing records or invoke service RPCs.
create table public.billing_customers (
  user_id uuid not null references auth.users(id) on delete restrict,
  stripe_account_id text not null check (stripe_account_id like 'acct_%'),
  livemode boolean not null,
  stripe_customer_id text,
  customer_operation_id uuid not null default gen_random_uuid(),
  customer_started_at timestamptz,
  checkout_attempt_id uuid,
  checkout_attempt_created_at timestamptz,
  checkout_session_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, stripe_account_id, livemode),
  unique (stripe_account_id, livemode, stripe_customer_id),
  unique (user_id, stripe_account_id, livemode, stripe_customer_id)
);

create table public.billing_subscriptions (
  user_id uuid not null,
  stripe_account_id text not null,
  livemode boolean not null,
  stripe_customer_id text not null,
  stripe_subscription_id text not null,
  stripe_price_id text not null,
  status text not null check (status in ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  refreshed_at timestamptz not null default now(),
  primary key (stripe_account_id, livemode, stripe_subscription_id),
  foreign key (user_id, stripe_account_id, livemode, stripe_customer_id)
    references public.billing_customers(user_id, stripe_account_id, livemode, stripe_customer_id) on delete restrict
);
create index billing_subscriptions_owner_idx on public.billing_subscriptions (user_id, stripe_account_id, livemode);

create table public.billing_webhook_events (
  stripe_account_id text not null,
  livemode boolean not null,
  stripe_event_id text not null,
  event_type text not null,
  event_created_at timestamptz not null,
  processed_at timestamptz not null default now(),
  primary key (stripe_account_id, livemode, stripe_event_id)
);

alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.billing_webhook_events enable row level security;
revoke all on public.billing_customers, public.billing_subscriptions, public.billing_webhook_events from public, anon, authenticated;
grant all on public.billing_customers, public.billing_subscriptions, public.billing_webhook_events to service_role;
grant select on public.billing_subscriptions to authenticated;
create policy billing_subscriptions_owner_read on public.billing_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

-- A durable lease spans Stripe HTTP requests. All commits validate its token and
-- expiration, so a worker that resumes after losing its lease cannot overwrite a
-- more recent Stripe snapshot. Contention returns null and is retried by Stripe.
create function public.acquire_billing_customer(
  p_user_id uuid, p_account_id text, p_livemode boolean, p_lease_token uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_row public.billing_customers;
begin
  if p_lease_token is null then raise exception 'BILLING_LEASE_REQUIRED'; end if;
  insert into public.billing_customers (user_id, stripe_account_id, livemode)
    values (p_user_id, p_account_id, p_livemode) on conflict do nothing;
  select * into v_row from public.billing_customers
    where user_id = p_user_id and stripe_account_id = p_account_id and livemode = p_livemode for update;
  if v_row.lease_expires_at > clock_timestamp() then return null; end if;
  update public.billing_customers set lease_token = p_lease_token,
    lease_expires_at = clock_timestamp() + interval '120 seconds', updated_at = clock_timestamp()
    where user_id = p_user_id and stripe_account_id = p_account_id and livemode = p_livemode returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

create function public.release_billing_customer(
  p_user_id uuid, p_account_id text, p_livemode boolean, p_lease_token uuid
) returns void language sql security invoker set search_path = '' as $$
  update public.billing_customers set lease_token = null, lease_expires_at = null
    where user_id = p_user_id and stripe_account_id = p_account_id and livemode = p_livemode and lease_token = p_lease_token;
$$;

-- Receipt and projection commit together. No stored raw event/payment/PII body.
-- The caller fetches the *latest* Stripe subscription only after acquiring the lease.
create function public.commit_billing_webhook(
  p_user_id uuid, p_account_id text, p_livemode boolean, p_lease_token uuid,
  p_event_id text, p_event_type text, p_event_created_at timestamptz,
  p_projection jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_row public.billing_customers;
begin
  select * into v_row from public.billing_customers
    where user_id = p_user_id and stripe_account_id = p_account_id and livemode = p_livemode for update;
  if not found or p_lease_token is null or v_row.lease_token is distinct from p_lease_token
    or v_row.lease_expires_at is null or v_row.lease_expires_at <= clock_timestamp() then
    raise exception 'BILLING_LEASE_LOST';
  end if;
  if exists (select 1 from public.billing_webhook_events where stripe_account_id = p_account_id
      and livemode = p_livemode and stripe_event_id = p_event_id) then return false; end if;
  if p_projection is not null then
    if p_projection->>'stripe_customer_id' is distinct from v_row.stripe_customer_id then
      raise exception 'BILLING_CUSTOMER_MISMATCH';
    end if;
    if p_projection ? 'revoke_subscription_id' then
      delete from public.billing_subscriptions where user_id = p_user_id and stripe_account_id = p_account_id
        and livemode = p_livemode and stripe_customer_id = v_row.stripe_customer_id
        and stripe_subscription_id = p_projection->>'revoke_subscription_id';
    else
    insert into public.billing_subscriptions (user_id, stripe_account_id, livemode, stripe_customer_id,
      stripe_subscription_id, stripe_price_id, status, current_period_end, cancel_at_period_end)
    values (p_user_id, p_account_id, p_livemode, v_row.stripe_customer_id,
      p_projection->>'stripe_subscription_id', p_projection->>'stripe_price_id', p_projection->>'status',
      (p_projection->>'current_period_end')::timestamptz, (p_projection->>'cancel_at_period_end')::boolean)
    on conflict (stripe_account_id, livemode, stripe_subscription_id) do update
      set status = excluded.status, stripe_price_id = excluded.stripe_price_id,
        current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
        refreshed_at = clock_timestamp()
      where public.billing_subscriptions.user_id = excluded.user_id
        and public.billing_subscriptions.stripe_customer_id = excluded.stripe_customer_id;
    if not found then raise exception 'BILLING_SUBSCRIPTION_OWNER_MISMATCH'; end if;
    end if;
  end if;
  insert into public.billing_webhook_events (stripe_account_id, livemode, stripe_event_id, event_type, event_created_at)
    values (p_account_id, p_livemode, p_event_id, p_event_type, p_event_created_at);
  return true;
end;
$$;

revoke all on function public.acquire_billing_customer(uuid,text,boolean,uuid) from public, anon, authenticated;
revoke all on function public.release_billing_customer(uuid,text,boolean,uuid) from public, anon, authenticated;
revoke all on function public.commit_billing_webhook(uuid,text,boolean,uuid,text,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.acquire_billing_customer(uuid,text,boolean,uuid) to service_role;
grant execute on function public.release_billing_customer(uuid,text,boolean,uuid) to service_role;
grant execute on function public.commit_billing_webhook(uuid,text,boolean,uuid,text,text,timestamptz,jsonb) to service_role;
