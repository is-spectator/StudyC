export const PLAN_TABLES = [
  "study_plans",
  "study_plan_tasks",
  "study_plan_evidence",
  "study_planning_requests",
] as const;
export const PLANS_SQL = `
CREATE TABLE study_plans(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL,title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),goal text NOT NULL CHECK(octet_length(goal)<=8000),due_date date,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,user_id),UNIQUE(id,user_id,study_set_id),FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE
);
CREATE INDEX plans_owner_set ON study_plans(user_id,study_set_id,created_at DESC,id DESC);
CREATE TABLE study_plan_tasks(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL,plan_id uuid NOT NULL,title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),due_date date,
 activity_kind text CHECK(activity_kind IN ('material','deck','quiz','note')),activity_id uuid,activity_title text,
 manual_completed_at timestamptz,manual_completed_by uuid REFERENCES users(id) ON DELETE CASCADE,cancelled_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((activity_kind IS NULL AND activity_id IS NULL AND activity_title IS NULL) OR (activity_kind IS NOT NULL AND activity_id IS NOT NULL AND activity_title IS NOT NULL)),
 CHECK((manual_completed_at IS NULL)=(manual_completed_by IS NULL)),
 UNIQUE(id,user_id),FOREIGN KEY(plan_id,user_id,study_set_id) REFERENCES study_plans(id,user_id,study_set_id) ON DELETE CASCADE,
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE
);
CREATE INDEX plan_tasks_owner ON study_plan_tasks(user_id,plan_id,created_at DESC,id DESC);
CREATE TABLE study_plan_evidence(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL,session_kind text NOT NULL CHECK(session_kind IN ('flashcard_session','spaced_review','quiz_attempt')),session_id uuid NOT NULL,
 completed_at timestamptz NOT NULL,linked_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(task_id,user_id) REFERENCES study_plan_tasks(id,user_id) ON DELETE CASCADE,UNIQUE(task_id,session_kind,session_id)
);
CREATE TABLE study_planning_requests(
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_request_id uuid NOT NULL,digest text NOT NULL,
 entity_kind text NOT NULL CHECK(entity_kind IN ('plan','task')),entity_id uuid NOT NULL,PRIMARY KEY(user_id,client_request_id)
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_plans FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_plan_tasks FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_plan_evidence FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_planning_requests FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
