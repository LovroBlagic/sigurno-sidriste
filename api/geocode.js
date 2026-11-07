// Vercel funkcija: /api/geocode
import { handleApi } from "../server/handlers.js";

export default (req, res) => handleApi("geocode", req, res);
