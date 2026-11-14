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
  const maxAgeMs = Math.max(15_000, Math.min(heartbeatIntervalMs * 3, 10 * 60_000));
  return now - timestamp <= maxAgeMs;
}
