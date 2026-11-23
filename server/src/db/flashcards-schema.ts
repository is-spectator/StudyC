export const FLASHCARD_TABLES = ['study_flashcard_decks', 'study_flashcards', 'study_flashcard_sessions', 'study_flashcard_reviews', 'study_flashcard_materializations'] as const;
export const FLASHCARDS_SCHEMA_SQL = /* sql */ `
CREATE TABLE study_flashcard_decks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL, title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160 AND title=btrim(title)),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), client_request_id uuid NOT NULL, creation_digest text NOT NULL,
 generation_job_id uuid REFERENCES study_generation_jobs(id) ON DELETE SET NULL,
 source_snapshots jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_snapshots)='array'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
 UNIQUE(id,user_id,study_set_id), UNIQUE(user_id,client_request_id), UNIQUE(user_id,generation_job_id)
);
CREATE INDEX study_flashcard_decks_owner_set ON study_flashcard_decks(user_id,study_set_id,id);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_flashcard_decks FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_flashcards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL, deck_id uuid NOT NULL, position integer NOT NULL CHECK(position>=0),
 front text NOT NULL CHECK(octet_length(front) BETWEEN 1 AND 2000), back text NOT NULL CHECK(octet_length(back) BETWEEN 1 AND 8000),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), citations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(citations)='array'),
 client_request_id uuid NOT NULL, creation_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(deck_id,user_id,study_set_id) REFERENCES study_flashcard_decks(id,user_id,study_set_id) ON DELETE CASCADE,
 UNIQUE(deck_id,position), UNIQUE(user_id,client_request_id)
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_flashcards FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_flashcard_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL, deck_id uuid NOT NULL, client_request_id uuid NOT NULL, creation_digest text NOT NULL,
 card_snapshots jsonb NOT NULL CHECK(jsonb_typeof(card_snapshots)='array' AND jsonb_array_length(card_snapshots)>0),
 next_index integer NOT NULL DEFAULT 0 CHECK(next_index>=0 AND next_index<=jsonb_array_length(card_snapshots)), version integer NOT NULL DEFAULT 1 CHECK(version>0),
 status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(deck_id,user_id,study_set_id) REFERENCES study_flashcard_decks(id,user_id,study_set_id) ON DELETE CASCADE,
 UNIQUE(id,user_id,study_set_id,deck_id), UNIQUE(user_id,client_request_id)
);
CREATE INDEX study_flashcard_sessions_owner_deck ON study_flashcard_sessions(user_id,study_set_id,deck_id,created_at DESC);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_flashcard_sessions FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_flashcard_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL, deck_id uuid NOT NULL, session_id uuid NOT NULL,
 card_id uuid NOT NULL, card_version integer NOT NULL CHECK(card_version>0), position integer NOT NULL CHECK(position>=0),
 rating text NOT NULL CHECK(rating IN ('again','hard','good','easy')), client_request_id uuid NOT NULL, creation_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(session_id,user_id,study_set_id,deck_id) REFERENCES study_flashcard_sessions(id,user_id,study_set_id,deck_id) ON DELETE CASCADE,
 UNIQUE(user_id,client_request_id), UNIQUE(session_id,position)
);
CREATE INDEX study_flashcard_reviews_owner_deck ON study_flashcard_reviews(user_id,study_set_id,deck_id,created_at DESC);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_flashcard_reviews FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TABLE study_flashcard_materializations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL, deck_id uuid NOT NULL, generation_job_id uuid NOT NULL,
 client_request_id uuid NOT NULL, creation_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,client_request_id),
 FOREIGN KEY(deck_id,user_id,study_set_id) REFERENCES study_flashcard_decks(id,user_id,study_set_id) ON DELETE CASCADE
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_flashcard_materializations FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
