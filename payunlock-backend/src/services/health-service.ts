import type { ReadinessResponse } from "@payunlock/api-contracts";

export class HealthService {
  constructor(private readonly repository: { isReady(): Promise<boolean> }) {}
  async readiness(): Promise<ReadinessResponse> {
    try {
      if (await this.repository.isReady()) return { status: "ready", database: "ready" };
    } catch { /* Readiness must not expose database details. */ }
    return { status: "unavailable", database: "unavailable" };
  }
}
