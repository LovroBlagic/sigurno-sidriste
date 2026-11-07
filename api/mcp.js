// Vercel funkcija: /mcp (preusmjereno u vercel.json) - MCP Streamable HTTP
import { handleMcp } from "../server/handlers.js";

export default (req, res) => handleMcp(req, res);
