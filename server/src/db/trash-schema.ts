export const TRASH_TABLES = [
  "study_set_lifecycle",
  "study_trash_requests",
] as const;
export const TRASH_SQL = `
CREATE TABLE study_set_lifecycle(
 study_set_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 version integer NOT NULL CHECK(version>0),deleted_at timestamptz,
 PRIMARY KEY(study_set_id,user_id),FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE
);
CREATE INDEX lifecycle_owner_trash ON study_set_lifecycle(user_id,study_set_id) WHERE deleted_at IS NOT NULL;
CREATE TABLE study_trash_requests(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_request_id uuid NOT NULL,
 study_set_id uuid NOT NULL,digest text NOT NULL,PRIMARY KEY(user_id,client_request_id),
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_set_lifecycle FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_trash_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
