import { inject } from "@vercel/analytics";

// Local development does not load the analytics script.
if (import.meta.env.PROD) inject({ mode: "production" });
