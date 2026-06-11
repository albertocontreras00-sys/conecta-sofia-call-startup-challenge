import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MasterTransport, AllTools, NoAuthTools } from './masterTransport.js';

class MasterTransportMcpHttp {
  health = (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      server: 'master-transport-mcp',
      transport: 'streamable-http',
      auth: 'none',
      totalTools: AllTools.length});
  };

  listTools = (_req, res) => {
    res.json({
      success: true,
      totalTools: AllTools.length,
      tools: NoAuthTools});
  };

  handleStreamableHttp = async (req, res) => {
    try {
      const masterTransport = new MasterTransport();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined});

      await masterTransport.connect(transport);

      transport.onerror = (error) => {
        console.error('Master MCP transport error:', error);
      };

      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        transport.close();
        masterTransport.close();
      });
    } catch (_error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'},
          id: null});
      } else {
        res.end();
      }
    }
  };
}

export { MasterTransportMcpHttp };
