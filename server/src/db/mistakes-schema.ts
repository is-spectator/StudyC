export const MISTAKE_TABLES = ['study_mistake_facts', 'study_mistake_reviews', 'study_mistake_review_events'] as const;
/** Identical SQL is used by the v8 migration and the repeatable maintenance backfill. */
export const MISTAKE_BACKFILL_SQL = `
INSERT INTO study_mistake_facts(user_id,study_set_id,quiz_id,attempt_id,question_index,first_wrong,final_wrong,first_answer,final_answer,question,sources,title,submitted_at)
SELECT a.user_id,q.study_set_id,a.quiz_id,a.id,(item.ordinality-1)::int,
       NOT first_event.correct,(a.answers->>(item.ordinality-1)::text)::int<>(item.question->>'answerIndex')::int,
       first_event.answer_index,(a.answers->>(item.ordinality-1)::text)::int,item.question,a.snapshot->'sources',a.snapshot->>'title',a.submitted_at
FROM study_quiz_attempts a
JOIN study_quizzes q ON q.id=a.quiz_id AND q.user_id=a.user_id
JOIN users u ON u.id=a.user_id AND u.deleted_at IS NULL
CROSS JOIN LATERAL jsonb_array_elements(a.snapshot->'questions') WITH ORDINALITY item(question,ordinality)
JOIN LATERAL (SELECT e.correct,e.answer_index FROM study_quiz_events e WHERE e.user_id=a.user_id AND e.attempt_id=a.id AND e.kind='answer' AND e.question_index=item.ordinality-1 ORDER BY e.version_after LIMIT 1) first_event ON true
WHERE a.status='submitted' AND (NOT first_event.correct OR (a.answers->>(item.ordinality-1)::text)::int<>(item.question->>'answerIndex')::int)
`;
export const MISTAKES_SQL = `
CREATE TABLE study_mistake_facts (
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, study_set_id uuid NOT NULL, quiz_id uuid NOT NULL, attempt_id uuid NOT NULL,
 question_index integer NOT NULL CHECK(question_index BETWEEN 0 AND 19),
 first_wrong boolean NOT NULL, final_wrong boolean NOT NULL, first_answer integer NOT NULL, final_answer integer NOT NULL,
 question jsonb NOT NULL, sources jsonb NOT NULL, title text NOT NULL, submitted_at timestamptz NOT NULL,
 PRIMARY KEY(attempt_id,question_index),
 FOREIGN KEY(attempt_id,user_id) REFERENCES study_quiz_attempts(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(quiz_id,user_id) REFERENCES study_quizzes(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
 CHECK(first_wrong OR final_wrong)
);
CREATE INDEX mistake_facts_owner_question ON study_mistake_facts(user_id,study_set_id,quiz_id,question_index,submitted_at DESC);
CREATE TABLE study_mistake_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 study_set_id uuid NOT NULL, quiz_id uuid NOT NULL, client_request_id uuid NOT NULL, digest text NOT NULL,
 data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(quiz_id,user_id) REFERENCES study_quizzes(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(study_set_id,user_id) REFERENCES study_sets(id,user_id) ON DELETE CASCADE,
 UNIQUE(user_id,client_request_id), UNIQUE(id,user_id)
);
CREATE INDEX mistake_reviews_owner_set ON study_mistake_reviews(user_id,study_set_id,created_at DESC,id DESC);
CREATE TABLE study_mistake_review_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 review_id uuid NOT NULL,client_request_id uuid NOT NULL,digest text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('answer','submit')),position integer,answer_index integer,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(review_id,user_id) REFERENCES study_mistake_reviews(id,user_id) ON DELETE CASCADE,
 UNIQUE(user_id,client_request_id)
);
CREATE UNIQUE INDEX mistake_review_one_submit ON study_mistake_review_events(review_id) WHERE kind='submit';
CREATE TRIGGER active_user_write BEFORE INSERT ON study_mistake_facts FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_mistake_reviews FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
CREATE TRIGGER active_user_write BEFORE INSERT ON study_mistake_review_events FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
${MISTAKE_BACKFILL_SQL} ON CONFLICT(attempt_id,question_index) DO NOTHING;
`;
