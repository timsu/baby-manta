-- AlterTable: convert skillRepos from TEXT to JSONB
CREATE OR REPLACE FUNCTION pg_temp.manta_skill_repos_text_to_jsonb(value text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  parsed jsonb;
BEGIN
  IF value IS NULL OR btrim(value) = '' THEN
    RETURN '[]'::jsonb;
  END IF;

  parsed := value::jsonb;
  IF jsonb_typeof(parsed) = 'array' THEN
    RETURN parsed;
  END IF;

  RETURN '[]'::jsonb;
EXCEPTION WHEN others THEN
  RETURN '[]'::jsonb;
END;
$$;

ALTER TABLE "repos" ALTER COLUMN "skillRepos" DROP DEFAULT;
ALTER TABLE "repos"
  ALTER COLUMN "skillRepos" TYPE JSONB
    USING pg_temp.manta_skill_repos_text_to_jsonb("skillRepos");
ALTER TABLE "repos" ALTER COLUMN "skillRepos" SET DEFAULT '[]'::jsonb;
