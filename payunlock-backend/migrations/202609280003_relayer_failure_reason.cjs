exports.up = (pgm) => pgm.sql(`ALTER TABLE relayer_jobs ADD COLUMN failure_reason text;`);
exports.down = (pgm) => pgm.sql(`ALTER TABLE relayer_jobs DROP COLUMN failure_reason;`);
