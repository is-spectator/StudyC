export const CALENDAR_TABLES = [
  "study_calendar_settings",
  "study_calendar_events",
  "study_calendar_requests",
] as const;
export const CALENDAR_SQL = `
CREATE TABLE study_calendar_settings(
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,time_zone text NOT NULL CHECK(char_length(time_zone) BETWEEN 1 AND 80),version integer NOT NULL CHECK(version>0)
);
CREATE TABLE study_calendar_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),description text NOT NULL CHECK(octet_length(description)<=8000),kind text NOT NULL CHECK(kind IN ('study','exam','personal')),
 all_day date,starts_at timestamptz,ends_at timestamptz,time_zone text,timing jsonb NOT NULL CHECK(jsonb_typeof(timing)='object'),
 study_set_id uuid,plan_id uuid,task_id uuid,creation_digest text NOT NULL,cancelled_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((all_day IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL AND time_zone IS NULL) OR (all_day IS NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND time_zone IS NOT NULL AND ends_at>starts_at AND ends_at<=starts_at+interval '7 days')),
 CHECK((task_id IS NULL AND study_set_id IS NULL AND plan_id IS NULL) OR (task_id IS NOT NULL AND study_set_id IS NOT NULL AND plan_id IS NOT NULL)),
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(plan_id,user_id) REFERENCES study_plans(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(task_id,user_id) REFERENCES study_plan_tasks(id,user_id) ON DELETE CASCADE
);
CREATE INDEX calendar_owner_start ON study_calendar_events(user_id,starts_at,id);
CREATE INDEX calendar_owner_day ON study_calendar_events(user_id,all_day,id);
CREATE UNIQUE INDEX calendar_active_task ON study_calendar_events(user_id,task_id) WHERE task_id IS NOT NULL AND cancelled_at IS NULL;
CREATE TABLE study_calendar_requests(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_request_id uuid NOT NULL,digest text NOT NULL,entity_kind text NOT NULL CHECK(entity_kind IN ('event','settings')),entity_id uuid NOT NULL,PRIMARY KEY(user_id,client_request_id)
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_calendar_settings FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_calendar_events FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_calendar_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
