import type { Pool } from "pg";

export class HealthRepository {
  constructor(private readonly pool: Pool) {}
  async isReady(): Promise<boolean> {
    const result = await this.pool.query<{ ready: boolean }>("SELECT EXISTS (SELECT 1 FROM payunlock_metadata WHERE key = 'foundation_version' AND value = '1') AS ready");
    return result.rows[0]?.ready === true;
  }
}
