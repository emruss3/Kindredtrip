-- Central error sink for edge functions (observability).
CREATE TABLE IF NOT EXISTS public.edge_function_errors (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fn          text NOT NULL,
  version     text,
  search_id   uuid,
  context     jsonb,
  error       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.edge_function_errors ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS edge_function_errors_fn_time_idx ON public.edge_function_errors (fn, created_at DESC);
CREATE INDEX IF NOT EXISTS edge_function_errors_time_idx    ON public.edge_function_errors (created_at DESC);

CREATE OR REPLACE VIEW public.v_edge_errors_24h
WITH (security_invoker = on) AS
SELECT fn, version, COUNT(*) AS errors_24h, MAX(created_at) AS last_seen,
       (array_agg(error ORDER BY created_at DESC))[1] AS latest_error
FROM public.edge_function_errors
WHERE created_at > now() - interval '24 hours'
GROUP BY fn, version
ORDER BY errors_24h DESC;
