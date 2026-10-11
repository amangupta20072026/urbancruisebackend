/**
 * ==============================================================================
 * Datetime helpers
 * ==============================================================================
 * Rule: every timestamp inside the app is UTC. Presentation-layer conversion to
 * IST or any other tz happens at the very edge, if at all.
 * ==============================================================================
 */

export const nowIso = (): string => new Date().toISOString();
