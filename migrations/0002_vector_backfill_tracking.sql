-- Track semantic indexing/backfill progress for archived documents.
-- Optional metadata: demo mode ignores these fields entirely.
ALTER TABLE documents ADD COLUMN vector_indexed_at TEXT;
ALTER TABLE documents ADD COLUMN vector_index_attempted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_vector_backfill
  ON documents (status, vector_indexed_at, vector_index_attempted_at, archived_at);
