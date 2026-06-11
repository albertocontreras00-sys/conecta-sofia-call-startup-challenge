/**
 * MCP HTTP/SSE Wrapper for Conecta Proxy
 * Provides HTTP endpoints and SSE connections for MCP servers
 */

import { ConectaAPIServer } from './mcpServer.js';
import { N8NWorkflowServer } from './n8nServer.js';
import { OPERATION_REGISTRY, getAllOperationNames } from './operationRegistry.js';

class MCPHttpWrapper {
  constructor() {
    // Initialize MCP server instances
    this.apiServer = new ConectaAPIServer();
    this.n8nServer = new N8NWorkflowServer();
    
    // Store active SSE connections
    this.sseConnections = new Map();
    
    // Connection counter for unique IDs
    this.connectionCounter = 0;
  }

  // Health check endpoint
  health = (req, res) => {
    try {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        servers: {
          api: {
            status: 'running',
            tools: getAllOperationNames().length
          },
          n8n: {
            status: 'running',
            tools: 9 // N8N server has 9 tools
          }
        },
        environment: {
          nodeEnv: process.env.NODE_ENV || 'development',
          orgId: process.env.CONECTA_ORG_ID ? 'configured' : 'missing',
          firebaseToken: process.env.FIREBASE_ID_TOKEN ? 'configured' : 'missing'
        }
      };

      res.json(health);
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  };

  // List all available tools
  listTools = async (req, res) => {
    try {
      const tools = {
        api: [],
        n8n: []
      };

      // Get API tools from registry
      for (const [name, operation] of Object.entries(OPERATION_REGISTRY)) {
        tools.api.push({
          name,
          description: operation.description,
          category: operation.category,
          endpoint: operation.endpoint,
          method: operation.method,
          inputSchema: operation.inputSchema
        });
      }

      // Add generic tools
      tools.api.push(
        {
          name: 'test_endpoint',
          description: 'Test any Conecta API endpoint with custom parameters',
          category: 'Generic HTTP Tools',
          inputSchema: {
            type: 'object',
            properties: {
              endpoint: { type: 'string', description: 'API endpoint path' },
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
              body: { type: 'object', description: 'Request body' },
              headers: { type: 'object', description: 'Additional headers' },
              params: { type: 'object', description: 'Query parameters' }
            },
            required: ['endpoint']
          }
        },
        {
          name: 'make_authenticated_request',
          description: 'Make a generic authenticated API request to any endpoint',
          category: 'Generic HTTP Tools',
          inputSchema: {
            type: 'object',
            properties: {
              endpoint: { type: 'string', description: 'API endpoint path' },
              method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
              body: { type: 'object', description: 'Request body' },
              headers: { type: 'object', description: 'Additional headers' },
              params: { type: 'object', description: 'Query parameters' }
            },
            required: ['endpoint']
          }
        },
        {
          name: 'bulk_operations',
          description: 'Execute multiple operations in a single request',
          category: 'Generic HTTP Tools',
          inputSchema: {
            type: 'object',
            properties: {
              operations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    operation: { type: 'string', description: 'Operation name' },
                    params: { type: 'object', description: 'Operation parameters' }
                  },
                  required: ['operation', 'params']
                },
                description: 'Array of operations to execute'
              },
              continueOnError: { type: 'boolean', description: 'Continue processing if individual operations fail', default: true }
            },
            required: ['operations']
          }
        }
      );

      // Get N8N tools (hardcoded for now)
      tools.n8n = [
        {
          name: 'trigger_webhook',
          description: 'Trigger an N8N webhook',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              webhookPath: { type: 'string', description: 'Webhook path' },
              payload: { type: 'object', description: 'Webhook payload data' }
            },
            required: ['webhookPath', 'payload']
          }
        },
        {
          name: 'send_email_workflow',
          description: 'Trigger email sending workflow',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              recipients: { type: 'array', items: { type: 'object' }, description: 'Array of recipient objects' },
              subject: { type: 'string', description: 'Email subject' },
              message: { type: 'string', description: 'Email message content' },
              orgId: { type: 'string', description: 'Organization ID' },
              userId: { type: 'string', description: 'User ID' }
            },
            required: ['recipients', 'subject', 'message', 'orgId', 'userId']
          }
        },
        {
          name: 'send_sms_workflow',
          description: 'Trigger SMS sending workflow',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Phone number to send SMS to' },
              message: { type: 'string', description: 'SMS message content' },
              contactId: { type: 'string', description: 'Contact ID (optional)' },
              orgId: { type: 'string', description: 'Organization ID' },
              userId: { type: 'string', description: 'User ID' }
            },
            required: ['to', 'message', 'orgId', 'userId']
          }
        },
        {
          name: 'test_workflow',
          description: 'Test a workflow with sample data',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              workflowType: { type: 'string', enum: ['email', 'sms', 'campaign', 'document_request'], description: 'Type of workflow to test' },
              testData: { type: 'object', description: 'Test data for the workflow' }
            },
            required: ['workflowType', 'testData']
          }
        },
        {
          name: 'get_workflow_status',
          description: 'Get status of a workflow execution',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              executionId: { type: 'string', description: 'Workflow execution ID' }
            },
            required: ['executionId']
          }
        },
        {
          name: 'create_workflow',
          description: 'Create a new n8n workflow with specified nodes and connections',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Workflow name' },
              description: { type: 'string', description: 'Workflow description' },
              nodes: { type: 'array', items: { type: 'object' }, description: 'Array of workflow nodes' },
              connections: { type: 'object', description: 'Node connections defining workflow flow' },
              active: { type: 'boolean', description: 'Whether to activate the workflow', default: true }
            },
            required: ['name', 'nodes']
          }
        },
        {
          name: 'list_workflows',
          description: 'List all workflows in n8n',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              activeOnly: { type: 'boolean', description: 'Show only active workflows', default: false }
            },
            required: []
          }
        },
        {
          name: 'update_workflow',
          description: 'Update an existing workflow',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              workflowId: { type: 'string', description: 'Workflow ID to update' },
              name: { type: 'string', description: 'New workflow name (optional)' },
              description: { type: 'string', description: 'New workflow description (optional)' },
              nodes: { type: 'array', items: { type: 'object' }, description: 'Updated array of workflow nodes (optional)' },
              connections: { type: 'object', description: 'Updated node connections (optional)' },
              active: { type: 'boolean', description: 'Whether to activate the workflow (optional)' }
            },
            required: ['workflowId']
          }
        },
        {
          name: 'delete_workflow',
          description: 'Delete a workflow',
          category: 'N8N Workflows',
          inputSchema: {
            type: 'object',
            properties: {
              workflowId: { type: 'string', description: 'Workflow ID to delete' }
            },
            required: ['workflowId']
          }
        }
      ];

      res.json({
        success: true,
        totalTools: tools.api.length + tools.n8n.length,
        tools
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  };

  // Call a specific tool
  callTool = async (req, res) => {
    try {
      const { tool, params = {}, server = 'api' } = req.body;

      if (!tool) {
        return res.status(400).json({
          success: false,
          error: 'Tool name is required'
        });
      }

      let result;
      if (server === 'n8n') {
        result = await this.n8nServer.handleToolRequest(tool, params);
      } else {
        result = await this.apiServer.handleToolRequest(tool, params);
      }

      res.json({
        success: true,
        tool,
        server,
        result
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        tool: req.body.tool,
        server: req.body.server || 'api'
      });
    }
  };

  // SSE connection for streaming
  sseConnection = (req, res) => {
    const { server } = req.params;
    const connectionId = ++this.connectionCounter;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Store connection
    this.sseConnections.set(connectionId, {
      res,
      server,
      connected: true,
      createdAt: new Date()
    });

    // Send initial connection event
    res.write(`data: ${JSON.stringify({
      type: 'connected',
      connectionId,
      server,
      timestamp: new Date().toISOString()
    })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
      this.sseConnections.delete(connectionId);
    });

    // Keep connection alive with periodic ping
    const pingInterval = setInterval(() => {
      if (this.sseConnections.has(connectionId)) {
        res.write(`data: ${JSON.stringify({
          type: 'ping',
          timestamp: new Date().toISOString()
        })}\n\n`);
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Ping every 30 seconds
  };

  // Send message to SSE connection
  sendSSEMessage(connectionId, message) {
    const connection = this.sseConnections.get(connectionId);
    if (connection && connection.connected) {
      try {
        connection.res.write(`data: ${JSON.stringify({
          ...message,
          timestamp: new Date().toISOString()
        })}\n\n`);
      } catch (error) {
        console.error('Error sending SSE message:', error);
        this.sseConnections.delete(connectionId);
      }
    }
  }

  // Broadcast message to all connections
  broadcastSSEMessage(message, serverFilter = null) {
    for (const [connectionId, connection] of this.sseConnections) {
      if (!serverFilter || connection.server === serverFilter) {
        this.sendSSEMessage(connectionId, message);
      }
    }
  }

  // Get connection statistics
  getConnectionStats() {
    const stats = {
      total: this.sseConnections.size,
      byServer: {
        api: 0,
        n8n: 0
      },
      connections: []
    };

    for (const [connectionId, connection] of this.sseConnections) {
      stats.byServer[connection.server]++;
      stats.connections.push({
        connectionId,
        server: connection.server,
        connected: connection.connected,
        createdAt: connection.createdAt
      });
    }

    return stats;
  }

  // Cleanup method
  cleanup() {
    for (const [_connectionId, connection] of this.sseConnections) {
      try {
        connection.res.end();
      } catch (error) {
        console.error('Error closing SSE connection:', error);
      }
    }
    this.sseConnections.clear();
  }
}

export { MCPHttpWrapper };
