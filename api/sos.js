// Vercel funkcija: /api/sos (DEMO - ništa se ne šalje spasiocima)
import { handleSos } from "../server/handlers.js";

export default (req, res) => handleSos(req, res);
