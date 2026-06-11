import express from 'express';
import type { Request } from 'express';
import { AllTools } from '../mcp/masterTransport.js';

const router = express.Router();

interface PublicMcpTool {
  name: string;
  description?: string;
}

function getPublicBaseUrl(req: Request) {
  const configuredBaseUrl = (process.env.PROXY_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  const [protoHeader] = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',');
  const proto = (protoHeader || 'https').trim();
  const host = req.get('x-forwarded-host') || req.get('host');
  if (host) {
    return `${proto}://${host}`.replace(/\/+$/, '');
  }

  return 'https://proxy.holaconecta.com';
}

function buildMasterManifest(req: Request) {
  const baseUrl = getPublicBaseUrl(req);
  const tools = (AllTools as PublicMcpTool[]).map((tool) => ({
    name: tool.name,
    description: tool.description}));

  return {
    name: 'Conecta Master MCP',
    description: 'Unified MCP server with GitHub, Neon, Infobip, AWS SES, and AWS S3 tools.',
    version: '1.0.0',
    transport: 'streamable-http',
    endpoint: `${baseUrl}/mcp/master`,
    health: `${baseUrl}/mcp/master/health`,
    tools: `${baseUrl}/mcp/master/tools`,
    servers: [
      {
        name: 'master',
        transport: 'streamable-http',
        endpoint: `${baseUrl}/mcp/master`,
        tools}
    ]};
}

router.get('/.well-known/mcp.json', (req, res) => {
  res.json(buildMasterManifest(req));
});

router.get('/mcp.json', (req, res) => {
  res.json(buildMasterManifest(req));
});

export default router;
