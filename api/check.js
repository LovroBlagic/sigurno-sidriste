// Vercel funkcija: /api/check
import { handleApi } from "../server/handlers.js";

export default (req, res) => handleApi("check", req, res);
