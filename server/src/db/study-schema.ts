/** StudyC business data is owned by the existing account, independently of PlanPlan plans. */
export const STUDY_SCHEMA_SQL = /* sql */ `
CREATE TABLE study_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 60 AND title = btrim(title)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  client_request_id uuid NOT NULL,
  creation_digest text NOT NULL CHECK (creation_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, client_request_id)
);
CREATE INDEX study_sets_owner_created ON study_sets(user_id, created_at DESC, id DESC);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_sets
  FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();

CREATE TABLE study_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_set_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120 AND title = btrim(title)),
  body text NOT NULL CHECK (octet_length(body) <= 1048576),
  format text NOT NULL DEFAULT 'plain_text' CHECK (format = 'plain_text'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  client_request_id uuid NOT NULL,
  creation_digest text NOT NULL CHECK (creation_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (study_set_id, user_id) REFERENCES study_sets(id, user_id) ON DELETE CASCADE,
  UNIQUE (user_id, client_request_id)
);
CREATE INDEX study_materials_owner_set_created ON study_materials(user_id, study_set_id, created_at DESC, id DESC);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_materials
  FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
