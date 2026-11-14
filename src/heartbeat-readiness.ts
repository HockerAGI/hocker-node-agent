/**
 * Health evidence must come from a completed Supabase heartbeat write, never
 * from an attempted write or an old status='online' database record.
 */
export function hasFreshNodeHeartbeat(
  lastSuccessIso: string | null,
  heartbeatIntervalMs: number,
  now = Date.now(),
): boolean {
  if (!lastSuccessIso || !Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 1) return false;
  const timestamp = Date.parse(lastSuccessIso);
  if (!Number.isFinite(timestamp) || timestamp > now) return false;
  const maxAgeMs = heartbeatIntervalMs * 3;
  return now - timestamp <= maxAgeMs;
}
