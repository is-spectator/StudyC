export const COPY_TABLES = ["study_copy_requests"] as const;
export const COPY_SQL = `CREATE TABLE study_copy_requests(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_request_id uuid NOT NULL,digest text NOT NULL,
 source_set_id uuid NOT NULL,target_set_id uuid NOT NULL,mappings jsonb NOT NULL CHECK(jsonb_typeof(mappings)='array'),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,client_request_id),
 FOREIGN KEY(source_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(target_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE
);
CREATE TRIGGER active_user_write BEFORE INSERT ON study_copy_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();`;
