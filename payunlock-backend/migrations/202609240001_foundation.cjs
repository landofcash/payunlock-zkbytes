exports.up = (pgm) => {
  pgm.createTable('payunlock_metadata', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'text', notNull: true },
  });
  pgm.sql("INSERT INTO payunlock_metadata (key, value) VALUES ('foundation_version', '1')");
};

exports.down = (pgm) => { pgm.dropTable('payunlock_metadata'); };
