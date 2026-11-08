// Vercel funkcija: /api/reports - opažanja na moru (DEMO, samo u memoriji)
import { handleReports } from "../server/handlers.js";

export default (req, res) => handleReports(req, res);
