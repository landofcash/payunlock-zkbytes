exports.up = pgm => pgm.sql(`
  CREATE TABLE offer_images (
    id uuid PRIMARY KEY, owner text NOT NULL REFERENCES wallet_identities(address),
    width integer NOT NULL, height integer NOT NULL, image bytea NOT NULL, thumbnail bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX offer_images_owner ON offer_images(owner,created_at);
  ALTER TABLE catalog_products ADD COLUMN images jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE offer_revisions ADD COLUMN images jsonb NOT NULL DEFAULT '[]';
`);
exports.down = pgm => pgm.sql(`ALTER TABLE offer_revisions DROP COLUMN images; ALTER TABLE catalog_products DROP COLUMN images; DROP TABLE offer_images;`);
