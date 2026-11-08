// Vercel funkcija: /api/vessels (brodovi uživo, AIS iz aisstream.io; ključ u varijabli AISSTREAM_KEY)
import { handleApi } from "../server/handlers.js";

export default (req, res) => handleApi("vessels", req, res);
