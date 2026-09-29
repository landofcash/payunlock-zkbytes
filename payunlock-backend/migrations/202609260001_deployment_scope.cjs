// Old test catalogs remain archived and are excluded from the active deployment.
exports.up = (pgm) => pgm.sql(`
  ALTER TABLE catalog_products ADD COLUMN deployment_scope text NOT NULL DEFAULT '';
  UPDATE catalog_products p SET deployment_scope = m.chain_id::text || ':' || m.contract
    FROM product_mappings m WHERE p.id = m.product_id;
  CREATE INDEX catalog_products_scope ON catalog_products(deployment_scope, id);
`);
exports.down = (pgm) => pgm.sql(`ALTER TABLE catalog_products DROP COLUMN deployment_scope;`);
