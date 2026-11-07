// Vercel funkcija: /api/find
import { handleApi } from "../server/handlers.js";

export default (req, res) => handleApi("find", req, res);
