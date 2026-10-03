/**
 * The customer list has a single source of truth at `lib/npcs.ts`; the web build
 * re-exports it here so the picker and the serverless function can never drift
 * apart. It used to live inside the API root because the function had to be
 * self-contained; now that the site and the functions are one Vercel project
 * rooted at the repository root, both can read the same file directly.
 */
export * from "../../lib/npcs";
