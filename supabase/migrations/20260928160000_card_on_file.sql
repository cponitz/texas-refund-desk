-- SPEC-03 (card on file; ADR 0021): what the server keeps after a confirmed SetupIntent. Written only by the claim
-- function's POST /claim/card from Stripe's response — brand, last four digits, the consent time and the payment-method
-- id SPEC-05 task 6 will charge off-session. No card number, expiry or CVC has a column; the check on card_last4 makes
-- sure nothing longer than four digits can ever land there. stripe_customer_id / card_on_file already exist (v2).
alter table customers
  add column card_brand               text,
  add column card_last4               text check (card_last4 ~ '^[0-9]{4}$'),
  add column card_consented_at        timestamptz,
  add column stripe_payment_method_id text;
