// Vercel funkcija: /api/topo (EMODnet 2018 i GEBCO 2020 s Open Topo Data; ona nema CORS pa preglednik ide preko nas)
import { handleApi } from "../server/handlers.js";

export default (req, res) => handleApi("topo", req, res);
