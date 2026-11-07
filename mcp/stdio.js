#!/usr/bin/env node
// MCP preko stdio - za Claude Desktop i Claude Code:  node mcp/stdio.js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";

await createMcpServer().connect(new StdioServerTransport());
