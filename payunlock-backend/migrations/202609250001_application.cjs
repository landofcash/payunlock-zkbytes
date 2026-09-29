exports.up = (pgm) => pgm.sql(`
  CREATE TABLE wallet_identities (
    address text PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE auth_challenges (
    id uuid PRIMARY KEY, address text NOT NULL, origin text NOT NULL,
    message text NOT NULL, expires_at timestamptz NOT NULL,
    consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
  CREATE TABLE auth_sessions (
    token_hash text PRIMARY KEY, address text NOT NULL REFERENCES wallet_identities(address),
    origin text NOT NULL, expires_at timestamptz NOT NULL
  );
  CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
  CREATE TABLE api_rate_buckets (
    key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
  );
  CREATE INDEX api_rate_buckets_expiry ON api_rate_buckets(expires_at);
  CREATE TABLE catalog_products (
    id uuid PRIMARY KEY, seller text NOT NULL REFERENCES wallet_identities(address),
    title text NOT NULL, description text NOT NULL,
    visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft','public','hidden')),
    draft_terms jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX catalog_products_discovery ON catalog_products(visibility,id);
  CREATE INDEX catalog_products_seller ON catalog_products(seller,id);
  CREATE TABLE offer_revisions (
    product_id uuid NOT NULL REFERENCES catalog_products(id), revision integer NOT NULL,
    title text NOT NULL, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(product_id,revision)
  );
  CREATE TABLE product_mappings (
    product_id uuid PRIMARY KEY REFERENCES catalog_products(id),
    chain_id integer NOT NULL CHECK (chain_id = 10143),
    contract text NOT NULL CHECK (contract ~ '^0x[0-9a-f]{40}$'),
    seller text NOT NULL CHECK (seller ~ '^0x[0-9a-f]{40}$'),
    product_key text NOT NULL CHECK (product_key ~ '^0x[0-9a-f]{64}$'),
    UNIQUE(chain_id,contract,seller,product_key)
  );
  CREATE TABLE checkout_intents (
    id uuid PRIMARY KEY, product_id uuid NOT NULL, revision integer NOT NULL,
    chain_id integer NOT NULL, contract text NOT NULL, buyer text NOT NULL REFERENCES wallet_identities(address),
    request_id text NOT NULL CHECK (request_id ~ '^0x[0-9a-f]{64}$'),
    expected_terms text NOT NULL, buyer_receiving jsonb NOT NULL, configuration jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(product_id,revision) REFERENCES offer_revisions(product_id,revision),
    UNIQUE(chain_id,contract,buyer,request_id)
  );
  CREATE TABLE purchased_offers (
    chain_id integer NOT NULL, contract text NOT NULL, order_id numeric(78,0) NOT NULL,
    intent_id uuid NOT NULL UNIQUE REFERENCES checkout_intents(id),
    PRIMARY KEY(chain_id,contract,order_id)
  );
  CREATE TABLE pending_operations (
    id uuid PRIMARY KEY, owner text NOT NULL REFERENCES wallet_identities(address),
    chain_id integer NOT NULL CHECK (chain_id = 10143), contract text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('registration','purchase','delivery','refund','dispute','arbitration')),
    request_id text, order_id numeric(78,0), transaction_hash text,
    encrypted_reference text NOT NULL CHECK (length(encrypted_reference) <= 131072),
    version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX pending_operations_owner ON pending_operations(owner,id);
`);
exports.down = (pgm) => pgm.sql(`
  DROP TABLE pending_operations, purchased_offers, checkout_intents, product_mappings,
    offer_revisions, catalog_products, api_rate_buckets, auth_sessions, auth_challenges, wallet_identities;
`);
