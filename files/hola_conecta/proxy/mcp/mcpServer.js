#!/usr/bin/env node

/**
 * Conecta API MCP Server
 * Provides comprehensive API testing and interaction capabilities
 * Extended with all 99+ ConectaAPI methods and bulk operations
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import { OPERATION_REGISTRY, getOperation } from './operationRegistry.js';
import { CONFIG, getBaseUrl, validateParameter } from './config.js';

class ConectaAPIServer {
  constructor() {
    this.server = new Server(
      {
        name: 'conecta-api',
        version: '2.0.0'},
      {
        capabilities: {
          tools: {}}}
    );

    // Enhanced configuration
    this.baseUrl = getBaseUrl();
    this.n8nBaseUrl = CONFIG.WEBHOOKS.N8N_BASE_URL;
    this.n8nWebhookKey = process.env.N8N_WEBHOOK_KEY;
    
    // Authentication and request tracking
    this.authToken = null;
    this.tokenExpiry = null;
    this.requestCount = 0;
    this.lastRequestTime = Date.now();
    
    // Circuit breaker state
    this.circuitBreakerState = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = null;
    
    // Request logging
    this.requestLog = [];
    
    this.setupToolHandlers();
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Generate tools from operation registry
      const tools = this.generateToolsFromRegistry();
      
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Check circuit breaker
        if (this.circuitBreakerState === 'OPEN') {
          if (Date.now() - this.lastFailureTime > CONFIG.ERROR_HANDLING.CIRCUIT_BREAKER_TIMEOUT) {
            this.circuitBreakerState = 'HALF_OPEN';
          } else {
            throw new Error('Circuit breaker is OPEN - service temporarily unavailable');
          }
        }

        // Log request
        this.logRequest(name, args);

        // Handle the request
        const result = await this.handleToolRequest(name, args);
        
        // Reset failure count on success
        this.failureCount = 0;
        this.circuitBreakerState = 'CLOSED';
        
        return result;
      } catch (error) {
        // Handle circuit breaker
        this.handleCircuitBreakerFailure();
        
      return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ],
          isError: true
        };
      }
    });
  }

  generateToolsFromRegistry() {
    const tools = [];
    
    // Add all operations from registry
    for (const [operationName, operation] of Object.entries(OPERATION_REGISTRY)) {
      tools.push({
        name: operationName,
        description: operation.description,
        inputSchema: operation.inputSchema
      });
    }
    
    // Add generic tools
    tools.push(
          {
            name: 'test_endpoint',
        description: 'Test any Conecta API endpoint with custom parameters',
            inputSchema: {
              type: 'object',
              properties: {
                endpoint: { type: 'string', description: 'API endpoint path (e.g., /api/contacts)' },
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
            body: { type: 'object', description: 'Request body for POST/PUT/PATCH requests' },
            headers: { type: 'object', description: 'Additional headers' },
            params: { type: 'object', description: 'Query parameters' }
              },
              required: ['endpoint']
            }
          },
          {
        name: 'make_authenticated_request',
        description: 'Make a generic authenticated API request to any endpoint',
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
    
    return tools;
  }

  // Enhanced infrastructure methods
  async handleToolRequest(name, args) {
    // Handle generic tools first
    if (name === 'test_endpoint') {
      return await this.testEndpoint(args);
    } else if (name === 'make_authenticated_request') {
      return await this.makeAuthenticatedRequest(args);
    } else if (name === 'bulk_operations') {
      return await this.bulkOperations(args);
    }
    
    // Handle operations from registry
    const operation = getOperation(name);
    if (operation) {
      return await this.executeOperation(operation, args);
    }
    
    throw new Error(`Unknown tool: ${name}`);
  }

  async executeOperation(operation, args) {
    // Validate input parameters
    this.validateInput(args, operation.inputSchema);
    
    // Build endpoint URL
    let endpoint = operation.endpoint;
    if (args.orgId && endpoint.includes('{orgId}')) {
      endpoint = endpoint.replace('{orgId}', args.orgId);
    }
    if (args.contactId && endpoint.includes('{contactId}')) {
      endpoint = endpoint.replace('{contactId}', args.contactId);
    }
    if (args.userId && endpoint.includes('{userId}')) {
      endpoint = endpoint.replace('{userId}', args.userId);
    }
    if (args.taskId && endpoint.includes('{taskId}')) {
      endpoint = endpoint.replace('{taskId}', args.taskId);
    }
    if (args.templateId && endpoint.includes('{templateId}')) {
      endpoint = endpoint.replace('{templateId}', args.templateId);
    }
    if (args.folderId && endpoint.includes('{folderId}')) {
      endpoint = endpoint.replace('{folderId}', args.folderId);
    }
    if (args.conversationId && endpoint.includes('{conversationId}')) {
      endpoint = endpoint.replace('{conversationId}', args.conversationId);
    }
    if (args.messageId && endpoint.includes('{messageId}')) {
      endpoint = endpoint.replace('{messageId}', args.messageId);
    }
    if (args.requestId && endpoint.includes('{requestId}')) {
      endpoint = endpoint.replace('{requestId}', args.requestId);
    }
    if (args.templateName && endpoint.includes('{templateName}')) {
      endpoint = endpoint.replace('{templateName}', args.templateName);
    }
    if (args.category && endpoint.includes('{category}')) {
      endpoint = endpoint.replace('{category}', args.category);
    }
    if (args.documentId && endpoint.includes('{documentId}')) {
      endpoint = endpoint.replace('{documentId}', args.documentId);
    }
    
    // Prepare request options
    const options = {
      method: operation.method,
      headers: {}
    };
    
    // Add body for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(operation.method)) {
      const body = { ...args };
      // Remove path parameters from body
      delete body.orgId;
      delete body.contactId;
      delete body.userId;
      delete body.taskId;
      delete body.templateId;
      delete body.folderId;
      delete body.conversationId;
      delete body.messageId;
      delete body.requestId;
      delete body.templateName;
      delete body.category;
      delete body.documentId;
      
      options.body = JSON.stringify(body);
    }
    
    // Make the request
    const result = await this.makeAuthenticatedRequest(endpoint, options);
    
        return {
          content: [
            {
              type: 'text',
          text: `${operation.description} Result:\n\nStatus: ${result.status} ${result.statusText}\n\nResponse:\n${JSON.stringify(result.data, null, 2)}`
        }
      ]
    };
  }

  validateInput(args, schema) {
    if (!schema || !schema.properties) return;
    
    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in args)) {
          throw new Error(`Missing required field: ${field}`);
        }
      }
    }
    
    // Validate field types and patterns
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      if (field in args) {
        if (!validateParameter(args[field], fieldSchema)) {
          throw new Error(`Invalid value for field ${field}: ${args[field]}`);
        }
      }
    }
  }

  logRequest(operation, args) {
    if (CONFIG.LOGGING.ENABLE_REQUEST_LOGGING) {
      const logEntry = {
        timestamp: new Date().toISOString(),
        operation,
        args: this.sanitizeArgs(args),
        requestCount: ++this.requestCount
      };
      
      this.requestLog.push(logEntry);
      
      // Keep only last 1000 requests
      if (this.requestLog.length > 1000) {
        this.requestLog = this.requestLog.slice(-1000);
      }
    }
  }

  sanitizeArgs(args) {
    const sanitized = { ...args };
    
    // Remove sensitive data
    const sensitiveFields = ['password', 'token', 'secret', 'key', 'auth'];
    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  handleCircuitBreakerFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= CONFIG.ERROR_HANDLING.CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreakerState = 'OPEN';
    }
  }

  async makeAuthenticatedRequest(endpoint, options = {}) {
    // Get or refresh authentication token
    const token = await this.getAuthToken();
    
    // Prepare headers
    const headers = {
      ...CONFIG.REQUEST.DEFAULT_HEADERS,
      'Authorization': `${CONFIG.AUTH.TOKEN_PREFIX}${token}`,
        'x-org-id': process.env.CONECTA_ORG_ID || 'test-org',
        ...options.headers
    };
    
    // Add query parameters if provided
    let url = `${this.baseUrl}${endpoint}`;
    if (options.params) {
      const params = new URLSearchParams(options.params);
      url += `?${params.toString()}`;
    }
    
    // Prepare request options
    const requestOptions = {
      ...options,
      headers,
      timeout: CONFIG.API.TIMEOUT
    };
    
    // Remove params from options as they're now in URL
    delete requestOptions.params;
    
    // Make request with retry logic
    let lastError;
    for (let attempt = 1; attempt <= CONFIG.API.RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, requestOptions);
        
        // Check if response is retryable
        if (CONFIG.ERROR_HANDLING.RETRYABLE_STATUS_CODES.includes(response.status) && attempt < CONFIG.API.RETRY_ATTEMPTS) {
          await this.delay(CONFIG.API.RETRY_DELAY * attempt);
          continue;
        }

    const data = await response.text();
    let jsonData;
    try {
      jsonData = JSON.parse(data);
    } catch {
      jsonData = { raw: data };
    }

    return {
      status: response.status,
      statusText: response.statusText,
      data: jsonData,
      headers: Object.fromEntries(response.headers.entries())
    };
      } catch (error) {
        lastError = error;
        if (attempt < CONFIG.API.RETRY_ATTEMPTS) {
          await this.delay(CONFIG.API.RETRY_DELAY * attempt);
        }
      }
    }
    
    throw lastError;
  }

  async getAuthToken() {
    // Check if current token is still valid
    if (this.authToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.authToken;
    }
    
    // Get new token (in real implementation, this would refresh from Firebase)
    this.authToken = process.env.FIREBASE_ID_TOKEN || 'test-token';
    this.tokenExpiry = Date.now() + CONFIG.AUTH.MAX_TOKEN_AGE;
    
    return this.authToken;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async bulkOperations({ operations, continueOnError = true }) {
    const results = [];
    const errors = [];
    
    for (let i = 0; i < operations.length; i++) {
      const { operation, params } = operations[i];
      
      try {
        const result = await this.handleToolRequest(operation, params);
        results.push({
          index: i,
          operation,
          success: true,
          result
        });
      } catch (error) {
        const errorResult = {
          index: i,
          operation,
          success: false,
          error: error.message
        };
        
        errors.push(errorResult);
        results.push(errorResult);
        
        if (!continueOnError) {
          break;
        }
      }
    }
    
    return {
      content: [
        {
          type: 'text',
          text: `Bulk Operations Results:\n\nTotal Operations: ${operations.length}\nSuccessful: ${results.filter(r => r.success).length}\nFailed: ${errors.length}\n\nResults:\n${JSON.stringify(results, null, 2)}`
        }
      ]
    };
  }

  async testEndpoint({ endpoint, method = 'GET', body, headers = {}, params = {} }) {
    const options = {
      method,
      headers: { ...headers },
      params
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const result = await this.makeAuthenticatedRequest(endpoint, options);
    
    return {
      content: [
        {
          type: 'text',
          text: `API Test Result for ${method} ${endpoint}:\n\nStatus: ${result.status} ${result.statusText}\n\nResponse:\n${JSON.stringify(result.data, null, 2)}`
        }
      ]
    };
  }


  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Conecta API MCP server running on stdio');
  }
}

export { ConectaAPIServer };
