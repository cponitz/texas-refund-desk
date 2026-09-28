-- Run after every migration in supabase/migrations has been applied to the scratch database (ci.yml).
-- Fails loudly if the v2 data model is not what the code expects.
do $$
declare missing text[];
begin
  select array_agg(x) into missing from unnest(array[
    'claims.customer_id', 'claims.findings', 'claims.service_type', 'customers.email', 'customers.card_on_file',
    'documents.claim_id', 'filings.claim_id', 'messages.claim_id', 'property_entities.entity_cd',
    'property_values.tax_year', 'record_checks.source', 'refunds.dispute_status', 'refunds.record_check_id',
    'inquiries.kind', 'inquiries.email', 'system_status.value',
    'messages.provider', 'messages.provider_message_id', 'messages.delivery_status', 'messages.delivery_detail',
    'mail_pieces.lob_id', 'mail_pieces.batch', 'mail_pieces.status', 'mail_pieces.to_override', 'mail_pieces.address_verification',
    'mail_pieces.pdf_sha256', 'mail_pieces.delivered_at', 'mail_pieces.events',
    'customers.card_brand', 'customers.card_last4', 'customers.card_consented_at', 'customers.stripe_payment_method_id'
  ]) x
  where not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = split_part(x, '.', 1) and c.column_name = split_part(x, '.', 2));
  if missing is not null then raise exception 'schema check failed, missing: %', missing; end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and column_name='customer_id' and table_name in ('documents','filings','messages')) then
    raise exception 'customer_id still present on a child table';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'documents_kind_check' and pg_get_constraintdef(oid) like '%typed_id%') then
    raise exception 'documents.kind must allow typed_id (SPEC-06)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='documents' and column_name='storage_path' and is_nullable='NO') then
    raise exception 'documents.storage_path must be nullable for typed_id rows';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='bulk_load_leads') then
    raise exception 'bulk_load_leads should be dropped';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='ops_events_by_kind') then
    raise exception 'ops_events_by_kind() missing (SPEC-09)';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'messages_provider_message_id_key') then
    raise exception 'messages.provider_message_id must be unique (SPEC-10)';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mail_pieces_lob_id_key') then
    raise exception 'mail_pieces.lob_id must be unique (SPEC-11)';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('ops_mail_kpis') )
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname in ('ops_mail_by_batch')) then
    raise exception 'ops_mail_kpis() / ops_mail_by_batch() missing (SPEC-11)';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'customers'::regclass and pg_get_constraintdef(oid) like '%card_last4%[0-9]{4}%') then
    raise exception 'customers.card_last4 must be constrained to exactly four digits (SPEC-03)';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name in ('card_number','card_exp','card_cvc','pan')) then
    raise exception 'customers must never hold card data beyond brand + last4 (SPEC-03)';
  end if;
  raise notice 'schema check passed';
end $$;
