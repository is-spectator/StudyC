/** Generation state belongs to StudyC. The global ledger retains no account or
 * material identifiers, so deleting an account cannot reset shared spending. */
export const GENERATION_IMMUTABLE_BODY = `
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.study_set_id IS DISTINCT FROM OLD.study_set_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
    OR NEW.request_digest IS DISTINCT FROM OLD.request_digest
    OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot
    OR NEW.provider_config IS DISTINCT FROM OLD.provider_config
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Generation input is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
`;

export const GENERATION_SCHEMA_SQL = /* sql */ `
CREATE FUNCTION studyc_generation_immutable() RETURNS trigger AS $$${GENERATION_IMMUTABLE_BODY}$$ LANGUAGE plpgsql;
CREATE TABLE study_generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_set_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind = 'study_outline'),
  client_request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
  provider_config jsonb NOT NULL CHECK (jsonb_typeof(provider_config) = 'object'),
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  result jsonb,
  error_code text,
  current_attempt_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
  UNIQUE (id,user_id),
  UNIQUE (user_id,client_request_id),
  CHECK ((status = 'succeeded') = (result IS NOT NULL))
);
CREATE INDEX study_generation_jobs_owner_set_created ON study_generation_jobs(user_id,study_set_id,created_at DESC,id DESC);
CREATE TRIGGER active_user_write BEFORE INSERT ON study_generation_jobs FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER immutable_input BEFORE UPDATE ON study_generation_jobs FOR EACH ROW EXECUTE FUNCTION studyc_generation_immutable();

CREATE TABLE study_generation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  user_id uuid NOT NULL,
  number integer NOT NULL CHECK (number BETWEEN 1 AND 3),
  client_request_id uuid NOT NULL,
  request_kind text NOT NULL CHECK (request_kind IN ('create','retry')),
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  budget_day date NOT NULL,
  reserved_tokens integer NOT NULL CHECK (reserved_tokens > 0),
  accounted_tokens bigint NOT NULL CHECK (accounted_tokens >= 0),
  usage_state text NOT NULL CHECK (usage_state IN ('reported','unknown','not_sent')),
  input_tokens bigint CHECK (input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0),
  cost_credits text,
  provider_request_id text,
  error_code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (job_id,user_id) REFERENCES study_generation_jobs(id,user_id) ON DELETE CASCADE,
  UNIQUE (job_id,number),
  UNIQUE (user_id,client_request_id),
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND finished_at IS NULL))
);
CREATE INDEX study_generation_attempts_queue ON study_generation_attempts(status,created_at,id);
CREATE INDEX study_generation_attempts_budget ON study_generation_attempts(user_id,budget_day);
CREATE TRIGGER active_user_write BEFORE INSERT ON study_generation_attempts FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();

CREATE TABLE study_generation_daily_budget (
  day date PRIMARY KEY,
  requests bigint NOT NULL CHECK (requests >= 0),
  tokens bigint NOT NULL CHECK (tokens >= 0)
);
`;
