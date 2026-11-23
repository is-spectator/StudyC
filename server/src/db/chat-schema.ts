export const CHAT_TABLES = ['study_chat_threads', 'study_chat_turns', 'study_generation_progress'] as const;
export const CHAT_IMMUTABLE_BODY = `
BEGIN
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'Chat question and generation identity are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
`;
export const CHAT_SCHEMA_SQL = `
ALTER TABLE study_generation_jobs DROP CONSTRAINT study_generation_jobs_kind_check;
ALTER TABLE study_generation_jobs ADD CONSTRAINT study_generation_jobs_kind_check CHECK (kind IN ('study_outline','chat_answer','flashcards','quiz'));
CREATE FUNCTION studyc_chat_turn_immutable() RETURNS trigger AS $$${CHAT_IMMUTABLE_BODY}$$ LANGUAGE plpgsql;
CREATE TABLE study_chat_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_set_id uuid NOT NULL, client_request_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
  UNIQUE(id,user_id), UNIQUE(user_id,client_request_id)
);
CREATE INDEX study_chat_threads_owner_set ON study_chat_threads(user_id,study_set_id,created_at DESC,id DESC);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_chat_threads FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_chat_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL, job_id uuid NOT NULL, client_request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  sequence integer NOT NULL CHECK(sequence BETWEEN 1 AND 100),
  question text NOT NULL CHECK(char_length(question) BETWEEN 1 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(thread_id,user_id) REFERENCES study_chat_threads(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(job_id,user_id) REFERENCES study_generation_jobs(id,user_id) ON DELETE CASCADE,
  UNIQUE(thread_id,sequence), UNIQUE(job_id), UNIQUE(user_id,client_request_id)
);
CREATE TRIGGER active_user_write BEFORE INSERT ON study_chat_turns FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER immutable_turn BEFORE UPDATE ON study_chat_turns FOR EACH ROW EXECUTE FUNCTION studyc_chat_turn_immutable();
CREATE TABLE study_generation_progress (
  attempt_id uuid PRIMARY KEY REFERENCES study_generation_attempts(id) ON DELETE CASCADE,
  job_id uuid NOT NULL, user_id uuid NOT NULL,
  sequence integer NOT NULL CHECK(sequence>0), text text NOT NULL CHECK(char_length(text)<=8000),
  FOREIGN KEY(job_id,user_id) REFERENCES study_generation_jobs(id,user_id) ON DELETE CASCADE
);
`;
