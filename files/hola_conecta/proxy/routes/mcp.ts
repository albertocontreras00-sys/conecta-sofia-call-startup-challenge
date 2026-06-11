/**
 * MCP Routes for Conecta Proxy
 * HTTP endpoints for MCP server functionality
 */

import express from 'express';
import { MCPHttpWrapper } from '../mcp/mcpHttpWrapper.js';
import { MasterTransportMcpHttp } from '../mcp/masterTransportMcpHttp.js';

const router = express.Router();

// Initialize MCP HTTP wrapper
const mcpWrapper = new MCPHttpWrapper();
const masterTransportMcp = new MasterTransportMcpHttp();

// Health check endpoint
router.get('/health', mcpWrapper.health);

// List all available tools
router.post('/tools/list', mcpWrapper.listTools);

// Call a specific tool
router.post('/tools/call', mcpWrapper.callTool);

// SSE connection for streaming (server: api|n8n)
router.get('/sse/:server', mcpWrapper.sseConnection);

// Master transport MCP over SSE/HTTP
router.get('/master/health', masterTransportMcp.health);
router.get('/master/tools', masterTransportMcp.listTools);
router.get('/master', masterTransportMcp.handleStreamableHttp);
router.post('/master', masterTransportMcp.handleStreamableHttp);
router.delete('/master', masterTransportMcp.handleStreamableHttp);
router.get('/master/sse', masterTransportMcp.handleStreamableHttp);
router.post('/master/sse', masterTransportMcp.handleStreamableHttp);
router.delete('/master/sse', masterTransportMcp.handleStreamableHttp);

// Connection statistics (admin endpoint)
router.get('/stats', (req, res) => {
  try {
    const stats = mcpWrapper.getConnectionStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Cleanup endpoint (admin endpoint)
router.post('/cleanup', (req, res) => {
  try {
    mcpWrapper.cleanup();
    res.json({
      success: true,
      message: 'All SSE connections cleaned up'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
export { masterTransportMcp };
