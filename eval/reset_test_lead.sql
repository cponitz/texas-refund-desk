-- Reset the synthetic lead CB-TEST-0001 so the claim page is open again (run in the Supabase SQL editor / MCP).
-- Data model v2: the engagement is `claims` (claim_id on documents/filings/messages); the account row for
-- selftest@example.com is kept.
with l as (select id from leads where claim_code = 'CB-TEST-0001'),
     c as (select id from claims where lead_id in (select id from l)),
     f as (select id from filings where claim_id in (select id from c))
, d0 as (delete from record_checks where filing_id in (select id from f))
, d1 as (delete from refunds   where filing_id  in (select id from f))
, d2 as (delete from messages  where claim_id in (select id from c))
, d3 as (delete from filings   where claim_id in (select id from c))
, d4 as (delete from documents where claim_id in (select id from c))
, d5 as (update customers set created_from_claim_id = null where created_from_claim_id in (select id from c))
, d6 as (delete from claims where lead_id in (select id from l))
update leads set status = 'new', opened_at = null where claim_code = 'CB-TEST-0001';
-- SPEC-03 S4: clear the saved test card on the synthetic account (the Stripe test-mode customer can stay; it is reused)
update customers set card_on_file = false, card_brand = null, card_last4 = null, card_consented_at = null, stripe_payment_method_id = null, stripe_customer_id = null where email = 'selftest@example.com';
update properties set situs_num='3675', situs_street='DUVAL ST', situs_zip='78721', situs_full='3675 DUVAL ST, AUSTIN, TX 78721' where prop_id = 999000001;
