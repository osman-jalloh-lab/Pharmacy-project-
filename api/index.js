// Vercel serverless entry: the whole Express app runs as one function.
// Static pages and /media images are served by Vercel's CDN from public/;
// vercel.json rewrites every /api/* request here.
import app from "../server.js";
export default app;
