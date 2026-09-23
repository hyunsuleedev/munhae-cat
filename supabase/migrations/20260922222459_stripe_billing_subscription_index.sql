-- Cover the full customer foreign key while retaining the owner lookup prefix.
drop index public.billing_subscriptions_owner_idx;
create index billing_subscriptions_owner_idx on public.billing_subscriptions
  (user_id, stripe_account_id, livemode, stripe_customer_id);
