/** Quizzes and every attempt retain the validated generation snapshot. */
export const QUIZ_TABLES = ['study_quizzes', 'study_quiz_materializations', 'study_quiz_attempts', 'study_quiz_events'] as const;
export const QUIZZES_SCHEMA_SQL = /* sql */ `
CREATE TABLE study_quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_set_id uuid NOT NULL, generation_id uuid NOT NULL, client_request_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions)='array' AND jsonb_array_length(questions) BETWEEN 1 AND 20),
  source_snapshot jsonb NOT NULL CHECK (jsonb_typeof(source_snapshot)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(generation_id,user_id) REFERENCES study_generation_jobs(id,user_id),
  UNIQUE(id,user_id), UNIQUE(user_id,generation_id), UNIQUE(user_id,client_request_id)
);
CREATE INDEX study_quizzes_owner_set_created ON study_quizzes(user_id,study_set_id,created_at DESC,id DESC);
CREATE TRIGGER active_user_write BEFORE INSERT ON study_quizzes FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_quiz_materializations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL, client_request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(quiz_id,user_id) REFERENCES study_quizzes(id,user_id) ON DELETE CASCADE,
  UNIQUE(user_id,client_request_id)
);
CREATE TRIGGER active_user_write BEFORE INSERT ON study_quiz_materializations FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL, client_request_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode IN ('practice','exam')), status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','submitted')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'), answers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(answers)='object'),
  first_correct integer, final_correct integer,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz,
  FOREIGN KEY(quiz_id,user_id) REFERENCES study_quizzes(id,user_id) ON DELETE CASCADE,
  UNIQUE(id,user_id), UNIQUE(user_id,client_request_id),
  CHECK((status='submitted' AND submitted_at IS NOT NULL AND first_correct IS NOT NULL AND final_correct IS NOT NULL)
    OR (status='in_progress' AND submitted_at IS NULL AND first_correct IS NULL AND final_correct IS NULL)),
  CHECK(first_correct BETWEEN 0 AND 20), CHECK(final_correct BETWEEN 0 AND 20)
);
CREATE INDEX study_quiz_attempts_owner_quiz_created ON study_quiz_attempts(user_id,quiz_id,created_at DESC,id DESC);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_quiz_attempts FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_quiz_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL, client_request_id uuid NOT NULL, request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('answer','submit')), question_index integer, answer_index integer, correct boolean,
  version_after integer NOT NULL CHECK(version_after>1), created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(attempt_id,user_id) REFERENCES study_quiz_attempts(id,user_id) ON DELETE CASCADE,
  UNIQUE(user_id,client_request_id), UNIQUE(attempt_id,version_after),
  CHECK((kind='answer' AND question_index IS NOT NULL AND answer_index IS NOT NULL AND question_index BETWEEN 0 AND 19 AND answer_index BETWEEN 0 AND 5 AND correct IS NOT NULL)
    OR (kind='submit' AND question_index IS NULL AND answer_index IS NULL AND correct IS NULL))
);
CREATE UNIQUE INDEX study_quiz_events_one_submission ON study_quiz_events(attempt_id) WHERE kind='submit';
CREATE TRIGGER active_user_write BEFORE INSERT ON study_quiz_events FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
