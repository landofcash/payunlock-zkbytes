exports.up = pgm => pgm.sql(`
  CREATE TABLE checkout_reviews (
    intent_id uuid NOT NULL REFERENCES checkout_intents(id), expected_terms text NOT NULL,
    revision integer NOT NULL, configuration jsonb NOT NULL,
    PRIMARY KEY(intent_id,expected_terms)
  );
  INSERT INTO checkout_reviews SELECT id,expected_terms,revision,configuration FROM checkout_intents;
  ALTER TABLE purchased_offers ADD COLUMN reviewed_revision integer;
  UPDATE purchased_offers p SET reviewed_revision=i.revision FROM checkout_intents i WHERE i.id=p.intent_id;
`);
exports.down = pgm => pgm.sql(`ALTER TABLE purchased_offers DROP COLUMN reviewed_revision; DROP TABLE checkout_reviews;`);
