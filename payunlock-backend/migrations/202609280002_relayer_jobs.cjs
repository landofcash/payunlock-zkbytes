exports.up = (pgm) => pgm.sql(`
  CREATE TABLE relayer_jobs (
    id uuid PRIMARY KEY,
    chain_id integer NOT NULL CHECK (chain_id = 10143),
    escrow text NOT NULL CHECK (escrow ~ '^0x[0-9a-f]{40}$'),
    router text NOT NULL CHECK (router ~ '^0x[0-9a-f]{40}$'),
    kind text NOT NULL CHECK (kind IN ('purchase','arbitration','action')),
    actor text NOT NULL CHECK (actor ~ '^0x[0-9a-f]{40}$'),
    nonce text NOT NULL CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
    request_id text,
    order_id numeric(78,0),
    data_hash text NOT NULL CHECK (data_hash ~ '^0x[0-9a-f]{64}$'),
    calldata text,
    expires_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','submitting','submitted','finalized','failed','uncertain')),
    transaction_hash text,
    attempts integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(chain_id,router,actor,nonce),
    CHECK ((kind='purchase' AND request_id IS NOT NULL AND order_id IS NULL) OR (kind='arbitration' AND order_id IS NOT NULL AND request_id IS NULL) OR (kind='action' AND request_id IS NULL AND order_id IS NULL))
  );
  CREATE INDEX relayer_jobs_status_updated ON relayer_jobs(status,updated_at);
  CREATE INDEX relayer_jobs_actor ON relayer_jobs(actor,created_at);
  CREATE TABLE relayer_attempts (
    id bigserial PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES relayer_jobs(id) ON DELETE CASCADE,
    attempt integer NOT NULL,
    transaction_hash text,
    reserved_cost_wei numeric(78,0),
    gas_cost_wei numeric(78,0),
    status text NOT NULL CHECK (status IN ('prepared','submitted','finalized','reverted','uncertain')),
    raw_transaction text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(job_id,attempt)
  );
`);
exports.down = (pgm) => pgm.sql(`DROP TABLE relayer_attempts, relayer_jobs;`);
