CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('CLIENT','WORKER','OWNER','ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('ACTIVE','SUSPENDED','PENDING_VERIFICATION','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('OPEN','CLAIMED','SUBMITTED','APPROVED','REJECTED','CANCELLED','DISPUTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE ledger_status AS ENUM ('PENDING','APPROVED','COMPLETED','CANCELLED','REFUNDED','WITHDRAWAL_REQUESTED','WITHDRAWAL_REVIEW','WITHDRAWAL_COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE deposit_status AS ENUM ('PENDING','UNDER_REVIEW','VERIFIED','PROCESSING','COMPLETED','REJECTED','FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE withdrawal_status AS ENUM ('WITHDRAWAL_REQUESTED','WITHDRAWAL_REVIEW','APPROVED','PROCESSING','COMPLETED','REJECTED','CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  status account_status NOT NULL DEFAULT 'ACTIVE',
  phone_e164 TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS clients (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED'
);

CREATE TABLE IF NOT EXISTS workers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  active_task_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS owner_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  gross_amount NUMERIC(20,8) NOT NULL CHECK (gross_amount > 0),
  currency CHAR(3) NOT NULL,
  platform_fee NUMERIC(20,8) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  net_worker_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  status task_status NOT NULL DEFAULT 'OPEN',
  due_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_client_idx ON tasks(client_id);
CREATE INDEX IF NOT EXISTS tasks_worker_idx ON tasks(worker_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);

CREATE TABLE IF NOT EXISTS task_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS balances (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  available_amount NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (available_amount >= 0),
  pending_amount NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (pending_amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL DEFAULT gen_random_uuid(),
  task_id UUID REFERENCES tasks(id),
  user_id UUID NOT NULL REFERENCES users(id),
  client_id UUID REFERENCES users(id),
  worker_id UUID REFERENCES users(id),
  gross_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(20,8) NOT NULL DEFAULT 0,
  tax_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  net_amount NUMERIC(20,8) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL,
  provider_reference TEXT,
  status ledger_status NOT NULL,
  description TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger_entries(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_transaction_idx ON ledger_entries(transaction_id);

CREATE TABLE IF NOT EXISTS billing_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT NOT NULL UNIQUE,
  task_id UUID REFERENCES tasks(id),
  client_id UUID NOT NULL REFERENCES users(id),
  worker_id UUID NOT NULL REFERENCES users(id),
  gross_amount NUMERIC(20,8) NOT NULL,
  platform_fee NUMERIC(20,8) NOT NULL,
  tax_amount NUMERIC(20,8) NOT NULL,
  net_worker_amount NUMERIC(20,8) NOT NULL,
  currency CHAR(3) NOT NULL,
  payment_status TEXT NOT NULL,
  provider_reference TEXT,
  tax_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(20,8) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  provider TEXT NOT NULL,
  provider_reference TEXT,
  status deposit_status NOT NULL DEFAULT 'PENDING',
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  webhook_events JSONB NOT NULL DEFAULT '[]'::jsonb,
  audit_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS deposits_provider_ref_uq ON deposits(provider,provider_reference) WHERE provider_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(20,8) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  payout_method TEXT NOT NULL,
  destination_ciphertext TEXT,
  destination_last4 TEXT,
  status withdrawal_status NOT NULL DEFAULT 'WITHDRAWAL_REQUESTED',
  provider_reference TEXT,
  review_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  environment TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  currencies TEXT[] NOT NULL DEFAULT '{}',
  countries TEXT[] NOT NULL DEFAULT '{}',
  config_ciphertext TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider,environment)
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tax_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled BOOLEAN NOT NULL DEFAULT false,
  tax_name TEXT,
  percentage NUMERIC(10,6) NOT NULL DEFAULT 0,
  registration_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  invoice_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  actor_role user_role,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  previous_state JSONB,
  new_state JSONB,
  ip_hash TEXT,
  user_agent TEXT,
  request_id TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_logs(actor_user_id);

CREATE TABLE IF NOT EXISTS disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id),
  opened_by UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT,
  resolved_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS file_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  UNIQUE(provider,event_id)
);

CREATE OR REPLACE FUNCTION deny_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are append-only';
END $$;

DROP TRIGGER IF EXISTS ledger_no_update ON ledger_entries;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();
DROP TRIGGER IF EXISTS ledger_no_delete ON ledger_entries;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION deny_ledger_mutation();
