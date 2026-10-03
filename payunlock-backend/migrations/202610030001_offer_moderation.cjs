exports.up = pgm => pgm.sql(`
  ALTER TABLE catalog_products ADD COLUMN frontpage_position integer CHECK (frontpage_position > 0);
  ALTER TABLE catalog_products ADD COLUMN restricted boolean NOT NULL DEFAULT false;
  CREATE UNIQUE INDEX catalog_products_frontpage ON catalog_products(deployment_scope,frontpage_position)
    WHERE frontpage_position IS NOT NULL;
  CREATE TABLE catalog_admin_state (
    deployment_scope text PRIMARY KEY, version bigint NOT NULL DEFAULT 0
  );
`);
exports.down = pgm => pgm.sql(`
  DROP TABLE catalog_admin_state;
  DROP INDEX catalog_products_frontpage;
  ALTER TABLE catalog_products DROP COLUMN restricted, DROP COLUMN frontpage_position;
`);
