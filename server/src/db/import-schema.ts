export const IMPORT_TABLES = [
  "study_import_requests",
  "study_import_items",
] as const;
export const IMPORT_SQL = `
CREATE TABLE study_import_requests(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_request_id uuid NOT NULL,digest text NOT NULL,
 target_set_id uuid NOT NULL,outcome jsonb NOT NULL CHECK(jsonb_typeof(outcome)='array'),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,client_request_id),FOREIGN KEY(target_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE
);
CREATE TABLE study_import_items(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,target_set_id uuid NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 source_key text NOT NULL CHECK(source_key='sf-k12:uploads'),source_index integer NOT NULL CHECK(source_index>=0),material_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,target_set_id,fingerprint),
 FOREIGN KEY(target_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(material_id) REFERENCES study_materials(id) ON DELETE CASCADE
);
CREATE TRIGGER active_user_write BEFORE INSERT ON study_import_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_import_items FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
