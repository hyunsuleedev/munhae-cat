begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'Assertion failed: %', message; end if; end $$;

select pg_temp.assert_true(not has_table_privilege('anon', 'public.billing_subscriptions', 'select'), 'anon cannot read');
select pg_temp.assert_true(not has_table_privilege('authenticated', 'public.billing_customers', 'select'), 'customer mappings private');
select pg_temp.assert_true(not has_table_privilege('authenticated', 'public.billing_webhook_events', 'select'), 'receipts private');
select pg_temp.assert_true(not has_table_privilege('authenticated', 'public.billing_subscriptions', 'insert,update,delete'), 'client cannot write');
select pg_temp.assert_true(not has_function_privilege('authenticated', 'public.acquire_billing_customer(uuid,text,boolean,uuid)', 'execute'), 'leases service-only');
select pg_temp.assert_true(not has_function_privilege('anon', 'public.commit_billing_webhook(uuid,text,boolean,uuid,text,text,timestamptz,jsonb)', 'execute'), 'webhook RPC service-only');
select pg_temp.assert_true((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.billing_customers'::regclass, 'public.billing_subscriptions'::regclass, 'public.billing_webhook_events'::regclass)), 'all billing tables RLS enabled');

insert into auth.users(id) values ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
set local role service_role;
select public.acquire_billing_customer('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000011');
update public.billing_customers set stripe_customer_id = 'cus_munhae' where user_id = '00000000-0000-4000-8000-000000000001';
select pg_temp.assert_true(public.acquire_billing_customer('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000012') is null, 'second lease blocked');
select public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000011',
  'evt_new','customer.subscription.updated','2026-01-02','{"stripe_customer_id":"cus_munhae","stripe_subscription_id":"sub_munhae","stripe_price_id":"price_munhae","status":"active","current_period_end":"2030-01-01","cancel_at_period_end":false}');
select pg_temp.assert_true(not public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000011',
  'evt_new','customer.subscription.updated','2026-01-02','{"stripe_customer_id":"cus_munhae","stripe_subscription_id":"sub_munhae","stripe_price_id":"price_munhae","status":"canceled","current_period_end":"2030-01-01","cancel_at_period_end":true}'), 'duplicate receipt not applied');
select pg_temp.assert_true((select status = 'active' from public.billing_subscriptions), 'duplicate did not change entitlement');

-- Delivery time is not object version: older events must project the freshly
-- fetched Stripe state, not reject a newer snapshot based on event.created.
select public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000011',
  'evt_old','invoice.payment_failed','2026-01-01','{"stripe_customer_id":"cus_munhae","stripe_subscription_id":"sub_munhae","stripe_price_id":"price_munhae","status":"past_due","current_period_end":"2030-01-01","cancel_at_period_end":false}');
select pg_temp.assert_true((select status = 'past_due' from public.billing_subscriptions), 'older event with latest snapshot applied');

do $$ begin
  perform public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000011',
    'evt_invalid','customer.subscription.updated',now(),'{"stripe_customer_id":"cus_munhae","stripe_subscription_id":"sub_munhae","stripe_price_id":"price_munhae","status":"invented","cancel_at_period_end":false}');
  raise exception 'Expected invalid projection failure';
exception when check_violation then null; end $$;
select pg_temp.assert_true(not exists (select from public.billing_webhook_events where stripe_event_id = 'evt_invalid'), 'failed projection leaves no receipt');

do $$ begin
  perform public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000012','evt_lost','test',now(),null);
  raise exception 'Expected stale lease failure';
exception when raise_exception then if sqlerrm <> 'BILLING_LEASE_LOST' then raise; end if; end $$;
select public.release_billing_customer('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000011');
do $$ begin
  perform public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',false,null,'evt_null','test',now(),null);
  raise exception 'Expected null lease failure';
exception when raise_exception then if sqlerrm <> 'BILLING_LEASE_LOST' then raise; end if; end $$;

-- An account or test/live boundary creates an independent mapping/receipt.
select public.acquire_billing_customer('00000000-0000-4000-8000-000000000001','acct_munhae',true,'00000000-0000-4000-8000-000000000011');
update public.billing_customers set stripe_customer_id = 'cus_munhae' where livemode = true;
select public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',true,'00000000-0000-4000-8000-000000000011',
  'evt_new','customer.subscription.updated',now(),'{"stripe_customer_id":"cus_munhae","stripe_subscription_id":"sub_munhae","stripe_price_id":"price_live","status":"active","current_period_end":"2030-01-01","cancel_at_period_end":false}');
select pg_temp.assert_true((select count(*) = 2 from public.billing_subscriptions), 'test/live projections isolated');
select public.acquire_billing_customer('00000000-0000-4000-8000-000000000001','acct_other',false,'00000000-0000-4000-8000-000000000011');
select pg_temp.assert_true((select count(*) = 3 from public.billing_customers), 'account mappings isolated');

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.assert_true((select count(*) = 2 from public.billing_subscriptions), 'owner can read own status');
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.assert_true((select count(*) = 0 from public.billing_subscriptions), 'other user cannot read status');
reset role;
set local role service_role;
select public.acquire_billing_customer('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000012');
select public.commit_billing_webhook('00000000-0000-4000-8000-000000000001','acct_munhae',false,'00000000-0000-4000-8000-000000000012',
  'evt_changed_price','customer.subscription.updated',now(),'{"stripe_customer_id":"cus_munhae","revoke_subscription_id":"sub_munhae"}');
select pg_temp.assert_true(not exists (select from public.billing_subscriptions where livemode = false), 'changed price revokes old entitlement');
select pg_temp.assert_true(exists (select from public.billing_subscriptions where livemode = true), 'revoke does not cross modes');
select pg_temp.assert_true(exists (select from public.billing_webhook_events where stripe_event_id = 'evt_changed_price'), 'revoke receipt committed');
rollback;
