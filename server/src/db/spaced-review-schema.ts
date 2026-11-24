export const SCHEDULE_OWNER_BODY = `BEGIN IF NOT EXISTS (SELECT 1 FROM study_flashcards WHERE id=NEW.card_id AND user_id=NEW.user_id) THEN RAISE EXCEPTION 'Card owner mismatch' USING ERRCODE='23503'; END IF; RETURN NEW; END;`;
export const SPACED_TABLES = ['study_flashcard_schedules', 'study_spaced_review_sessions', 'study_spaced_review_actions'] as const;
export const SPACED_SQL = `
CREATE TABLE study_flashcard_schedules (
 card_id uuid PRIMARY KEY REFERENCES study_flashcards(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 card_version integer NOT NULL CHECK(card_version>0), revision integer NOT NULL CHECK(revision>0),
 stage integer NOT NULL CHECK(stage BETWEEN -1 AND 5), rule_version text NOT NULL,
 due_at timestamptz NOT NULL, reviewed_at timestamptz NOT NULL
);
CREATE FUNCTION studyc_schedule_owner() RETURNS trigger LANGUAGE plpgsql AS $guard$ ${SCHEDULE_OWNER_BODY} $guard$;
CREATE TRIGGER schedule_owner BEFORE INSERT OR UPDATE ON study_flashcard_schedules FOR EACH ROW EXECUTE FUNCTION studyc_schedule_owner();
CREATE INDEX spaced_due_owner ON study_flashcard_schedules(user_id,due_at);
CREATE TABLE study_spaced_review_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL, deck_id uuid NOT NULL, client_request_id uuid NOT NULL, digest text NOT NULL,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(deck_id,user_id,study_set_id) REFERENCES study_flashcard_decks(id,user_id,study_set_id) ON DELETE CASCADE,
 UNIQUE(user_id,client_request_id), UNIQUE(id,user_id)
);
CREATE INDEX spaced_sessions_deck ON study_spaced_review_sessions(user_id,deck_id,created_at DESC);
CREATE TABLE study_spaced_review_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0), client_request_id uuid NOT NULL,
 digest text NOT NULL, outcome jsonb NOT NULL, before_state jsonb, after_state jsonb,
 FOREIGN KEY(session_id,user_id) REFERENCES study_spaced_review_sessions(id,user_id) ON DELETE CASCADE,
 UNIQUE(user_id,client_request_id), UNIQUE(session_id,position)
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_flashcard_schedules FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_spaced_review_sessions FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_spaced_review_actions FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
