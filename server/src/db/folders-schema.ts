export const FOLDER_TABLES = [
  "study_folders",
  "study_folder_assignments",
  "study_folder_requests",
] as const;
export const FOLDERS_SQL = `
CREATE TABLE study_folders(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 80 AND title=btrim(title)),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,user_id)
);
CREATE UNIQUE INDEX folders_owner_title ON study_folders(user_id,lower(title)) WHERE deleted_at IS NULL;
CREATE INDEX folders_owner_active ON study_folders(user_id,id) WHERE deleted_at IS NULL;
CREATE TABLE study_folder_assignments(
 study_set_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,folder_id uuid,
 version integer NOT NULL CHECK(version>0),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(study_set_id,user_id),
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(folder_id,user_id) REFERENCES study_folders(id,user_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX folder_assignment_owner ON study_folder_assignments(user_id,folder_id,study_set_id);
CREATE TABLE study_folder_requests(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_request_id uuid NOT NULL,digest text NOT NULL,
 entity_kind text NOT NULL CHECK(entity_kind IN ('folder','assignment','remove')),entity_id uuid NOT NULL,outcome jsonb,PRIMARY KEY(user_id,client_request_id)
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_folders FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_folder_assignments FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_folder_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
