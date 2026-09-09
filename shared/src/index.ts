/**
 * Types shared by the frontend and the backend: API contracts, config shapes, job/event models.
 * Kept free of runtime dependencies so both sides can import it.
 */
export const APP_NAME = "epic-git";

/** Placeholder until stage 1 defines the real API surface (see plan_work.md, sections 2–3). */
export type ApiVersion = 1;
