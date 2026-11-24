export const NOTE_TABLES = [
  "study_notes",
  "study_note_origins",
  "study_note_materializations",
] as const;
export const NOTES_SQL = `
ALTER TABLE study_generation_jobs DROP CONSTRAINT study_generation_jobs_kind_check;
ALTER TABLE study_generation_jobs ADD CONSTRAINT study_generation_jobs_kind_check CHECK(kind IN ('study_outline','chat_answer','flashcards','quiz','study_note'));
CREATE TABLE study_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL,title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),
 body text NOT NULL CHECK(octet_length(body) BETWEEN 1 AND 65536),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 manually_edited boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,UNIQUE(id,user_id,study_set_id)
);
CREATE INDEX notes_owner_set ON study_notes(user_id,study_set_id,created_at DESC,id DESC);
CREATE TABLE study_note_origins (
 note_id uuid PRIMARY KEY,user_id uuid NOT NULL,study_set_id uuid NOT NULL,job_id uuid NOT NULL,
 result jsonb NOT NULL,sources jsonb NOT NULL,
 FOREIGN KEY(note_id,user_id,study_set_id) REFERENCES study_notes(id,user_id,study_set_id) ON DELETE CASCADE,
 FOREIGN KEY(job_id,user_id) REFERENCES study_generation_jobs(id,user_id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(user_id,job_id)
);
CREATE TABLE study_note_materializations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,study_set_id uuid NOT NULL,note_id uuid NOT NULL,
 client_request_id uuid NOT NULL,digest text NOT NULL,
 FOREIGN KEY(note_id,user_id,study_set_id) REFERENCES study_notes(id,user_id,study_set_id) ON DELETE CASCADE,UNIQUE(user_id,client_request_id)
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_notes FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_note_origins FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_note_materializations FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
