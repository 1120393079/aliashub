DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'alias-hub') THEN
    CREATE ROLE "alias-hub" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;

CREATE OR REPLACE FUNCTION public.alias_hub_openai_oauth_credentials(p_account_id bigint)
RETURNS TABLE (
  nfapi_account_id bigint,
  email text,
  access_token text,
  refresh_token text,
  id_token text,
  chatgpt_account_id text,
  chatgpt_user_id text,
  expires_at text,
  plan_type text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT
    account.id,
    COALESCE(account.credentials ->> 'email', ''),
    COALESCE(account.credentials ->> 'access_token', ''),
    COALESCE(account.credentials ->> 'refresh_token', ''),
    COALESCE(account.credentials ->> 'id_token', ''),
    COALESCE(account.credentials ->> 'chatgpt_account_id', ''),
    COALESCE(account.credentials ->> 'chatgpt_user_id', ''),
    COALESCE(account.credentials ->> 'expires_at', ''),
    COALESCE(account.credentials ->> 'plan_type', '')
  FROM public.accounts AS account
  WHERE account.id = p_account_id
    AND lower(account.platform) = 'openai'
    AND lower(account.type) = 'oauth'
    AND lower(account.status) = 'active'
  LIMIT 1
$function$;

ALTER FUNCTION public.alias_hub_openai_oauth_credentials(bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.alias_hub_openai_oauth_credentials(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.alias_hub_openai_oauth_credentials(bigint) TO "alias-hub";
GRANT CONNECT ON DATABASE sub2api TO "alias-hub";
GRANT USAGE ON SCHEMA public TO "alias-hub";
REVOKE ALL ON TABLE public.accounts FROM "alias-hub";
