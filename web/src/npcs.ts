/**
 * The customer list is owned by the API project so the deployed function is
 * fully self-contained (Vercel's Root Directory is `api/`, and a function may
 * not import files from outside it). The web build reads the same file here.
 */
export * from "../../api/lib/npcs";
