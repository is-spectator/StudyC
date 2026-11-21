/** Original PDF bytes stay on disk. These rows record ownership, parse status, and page offsets. */
export const STUDY_FILES_SQL = /* sql */ `
CREATE TABLE study_source_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_set_id uuid NOT NULL,
  material_id uuid,
  client_request_id uuid NOT NULL,
  creation_digest text NOT NULL CHECK (creation_digest ~ '^[0-9a-f]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  display_name text NOT NULL CHECK (
    char_length(display_name) BETWEEN 1 AND 80
    AND display_name = btrim(display_name)
    AND strpos(display_name, '/') = 0
  ),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 8388608),
  status text NOT NULL CHECK (status IN (
    'ready', 'no_extractable_text', 'encrypted_pdf', 'invalid_pdf', 'text_too_large', 'too_many_pages'
  )),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0 AND page_count <= 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (study_set_id, user_id) REFERENCES study_sets(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (material_id) REFERENCES study_materials(id) ON DELETE CASCADE,
  UNIQUE (id, user_id),
  UNIQUE (user_id, client_request_id),
  CHECK ((status = 'ready') = (material_id IS NOT NULL))
);
CREATE INDEX study_source_files_owner_set_created ON study_source_files(user_id, study_set_id, created_at DESC, id DESC);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_source_files
  FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();

CREATE TABLE study_source_pages (
  source_file_id uuid NOT NULL,
  user_id uuid NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 30),
  char_start integer NOT NULL CHECK (char_start >= 0),
  char_end integer NOT NULL CHECK (char_end >= char_start),
  PRIMARY KEY (source_file_id, page_number),
  FOREIGN KEY (source_file_id, user_id) REFERENCES study_source_files(id, user_id) ON DELETE CASCADE
);
CREATE TRIGGER active_user_write BEFORE INSERT OR UPDATE ON study_source_pages
  FOR EACH ROW EXECUTE FUNCTION planplan_active_user_write();
`;
