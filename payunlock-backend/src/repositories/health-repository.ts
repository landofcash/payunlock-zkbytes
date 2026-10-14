import type {Pool} from "pg";

export class HealthRepository {
  constructor(private readonly pool: Pool) {
  }

  async isReady(): Promise<boolean> {
    const result = await this.pool.query<{ ready: boolean }>(`SELECT EXISTS (SELECT 1
                                                                             FROM payunlock_metadata
                                                                             WHERE key = 'foundation_version' AND value = '1')
                                                                         AND
                                                                     to_regclass('catalog_products') IS NOT NULL AND
                                                                     to_regclass('checkout_intents') IS NOT NULL
                                                                         AND
                                                                     to_regclass('auth_sessions') IS NOT NULL AND
                                                                     to_regclass('pending_operations') IS NOT NULL AS ready`);
    return result.rows[0]?.ready === true;
  }
}
