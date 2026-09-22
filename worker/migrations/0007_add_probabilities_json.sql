-- Add probabilities_json column to store all category probabilities
ALTER TABLE classification_logs
  ADD COLUMN probabilities_json TEXT;

-- Same for cache table
ALTER TABLE classification_cache
  ADD COLUMN probabilities_json TEXT;