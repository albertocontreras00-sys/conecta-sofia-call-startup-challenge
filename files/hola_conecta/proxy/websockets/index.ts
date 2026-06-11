// websockets/index.ts - Main WebSocket server setup and routing
import crypto from 'crypto';
import type { Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { logError, logWarn } from '../utils/logger.js';
import { handleInfobipMediaWebSocket } from '../services/voice/infobipMediaWebSocketService.ts';
import { canUpgradeToWebSocket, logConnectionDiagnostics } from './diagnostics.js';
import { handleNotificationConnection } from './handlers/notificationsHandler.js';
import { getTicketStoreSize, redeemTicket } from './wsTicketStore.js';
import type { WebSocketUpgradeRequest } from './types.js';
import { getErrorMessage } from './types.js';

const NOTIFICATIONS_PATH = '/api/notifications/stream';
const NOTIFICATIONS_WS_PROXY_PATH = '/api/ws/notifications/stream';
const INFOBIP_VOICE_STREAM_PATH = '/webhooks/infobip/voice/stream';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TICKET_MIN_LENGTH = 20;
const TICKET_MAX_LENGTH = 2048;
const THROTTLE_WINDOW_MS = 10_000;
const THROTTLE_MAX_REQUESTS = 30;

function normalizedPathname(pathname: string | null): string | null {
  return pathname?.replace(/^\/api\/ws/, '/api') || pathname;
}

function requestId(req: WebSocketUpgradeRequest): string {
  const header = req.headers['x-request-id'] || req.headers['x-debug-request-id'];
  return Array.isArray(header) ? header[0] || crypto.randomUUID() : header || crypto.randomUUID();
}

function writeHttpError(socket: Duplex, status: number, statusText: string, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nContent-Type: text/plain\r\n\r\n${reason}`);
  socket.destroy();
}

function clientIp(req: WebSocketUpgradeRequest): string {
  return req.socket.remoteAddress || 'unknown';
}

function isUpgradeRateLimited(ip: string): { limited: boolean; count: number; windowMs: number } {
  const now = Date.now();
  const throttleKey = `ws-upgrade:${ip}`;

  if (!global.wsUpgradeThrottle) {
    global.wsUpgradeThrottle = new Map();
  }

  const throttleEntry = global.wsUpgradeThrottle.get(throttleKey);
  if (!throttleEntry) {
    global.wsUpgradeThrottle.set(throttleKey, { startTime: now, count: 1 });
    return { limited: false, count: 1, windowMs: 0 };
  }

  const windowMs = now - throttleEntry.startTime;
  if (windowMs > THROTTLE_WINDOW_MS) {
    global.wsUpgradeThrottle.set(throttleKey, { startTime: now, count: 1 });
    return { limited: false, count: 1, windowMs: 0 };
  }

  if (throttleEntry.count >= THROTTLE_MAX_REQUESTS) {
    return { limited: true, count: throttleEntry.count, windowMs };
  }

  throttleEntry.count += 1;

  if (global.wsUpgradeThrottle.size > 1000) {
    for (const [key, entry] of global.wsUpgradeThrottle.entries()) {
      if (now - entry.startTime > THROTTLE_WINDOW_MS) {
        global.wsUpgradeThrottle.delete(key);
      }
    }
  }

  return { limited: false, count: throttleEntry.count, windowMs };
}

function parseUpgradeUrl(req: WebSocketUpgradeRequest): {
  pathname: string | null;
  normalized: string | null;
  orgId: string | null;
  ticket: string | null;
} {
  const parsed = new URL(req.url || '/', 'http://localhost');
  return {
    pathname: parsed.pathname,
    normalized: normalizedPathname(parsed.pathname),
    orgId: parsed.searchParams.get('org_id'),
    ticket: parsed.searchParams.get('ticket')?.trim() || null,
  };
}

function routeConnection(ws: WebSocket, req: WebSocketUpgradeRequest): void {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;

  if (pathname === INFOBIP_VOICE_STREAM_PATH) {
    handleInfobipMediaWebSocket({
      ws,
      path: pathname,
      query: new URL(req.url || '/', 'http://localhost').searchParams,
      requestId: requestId(req),
      remoteAddress: clientIp(req)
    });
    return;
  }

  if (!ws.orgId && req.orgId) ws.orgId = req.orgId;
  if (!ws.userId && req.userId) ws.userId = req.userId;

  if (pathname !== NOTIFICATIONS_PATH && pathname !== NOTIFICATIONS_WS_PROXY_PATH) {
    void logError('websocket-setup', 'Unknown WebSocket path', { pathname });
    ws.close(1008, 'Unknown path');
    return;
  }

  if (!ws.userId && !req.userId && !req.user?.uid) {
    void logError('websocket-setup', 'Connection rejected: missing userId on WebSocket object', null, {
      pathname,
      wsOrgId: ws.orgId || 'missing',
      wsUserId: ws.userId || 'missing',
      reqOrgId: req.orgId || 'missing',
      reqUserId: req.userId || 'missing',
      reqUserUid: req.user?.uid || 'missing',
    });
    ws.close(1008, 'Missing user context');
    return;
  }

  ws.userId ||= req.userId || req.user?.uid || null;

  if (!req.user) {
    void logError('websocket-setup', 'Connection rejected: missing authenticated user', {
      pathname,
      userId: ws.userId || 'missing',
    });
    ws.close(1008, 'Missing authenticated user');
    return;
  }

  void handleNotificationConnection(ws, req, req.user).catch((handlerError: unknown) => {
    void logError('websocket-setup', 'Error in notification connection handler', handlerError, {
      pathname,
      orgId: ws.orgId || 'none',
      userId: ws.userId || 'none',
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1011, 'Internal server error in handler');
    }
  });
}

async function handleNotificationUpgrade(
  wss: WebSocketServer,
  req: WebSocketUpgradeRequest,
  socket: Duplex,
  head: Buffer,
  pathname: string | null,
  orgId: string | null,
  ticket: string | null,
): Promise<void> {
  const upgradeRequestId = requestId(req);
  const ip = clientIp(req);

  if (orgId && !UUID_REGEX.test(orgId)) {
    const reason = 'Invalid org_id UUID format';
    logWarn('websocket-setup', `[WS] REJECT - ${reason}`, {
      requestId: upgradeRequestId,
      orgId,
      orgIdLength: orgId.length,
      pathname,
      ip,
    });
    writeHttpError(socket, 400, 'Bad Request', reason);
    return;
  }

  if (ticket && (ticket.length < TICKET_MIN_LENGTH || ticket.length > TICKET_MAX_LENGTH)) {
    const reason = `Invalid ticket length (must be ${TICKET_MIN_LENGTH}-${TICKET_MAX_LENGTH} characters)`;
    logWarn('websocket-setup', `[WS] REJECT - ${reason}`, {
      requestId: upgradeRequestId,
      orgId: orgId || 'missing',
      ticketLength: ticket.length,
      pathname,
      ip,
    });
    writeHttpError(socket, 400, 'Bad Request', reason);
    return;
  }

  const throttle = isUpgradeRateLimited(ip);
  if (throttle.limited) {
    const reason = 'Too many upgrade requests (rate limit exceeded)';
    logWarn('websocket-setup', `[WS] REJECT - ${reason}`, {
      requestId: upgradeRequestId,
      orgId: orgId || 'missing',
      ip,
      count: throttle.count,
      windowMs: throttle.windowMs,
    });
    writeHttpError(socket, 429, 'Too Many Requests', reason);
    return;
  }

  if (!ticket) {
    const reason = 'Notification WebSocket requires a valid ticket';
    logWarn('websocket-setup', `[WS] REJECT - ${reason}`, {
      requestId: upgradeRequestId,
      orgId: orgId || 'missing',
      pathname,
      ip,
    });
    writeHttpError(socket, 401, 'Unauthorized', reason);
    return;
  }

  const ticketUser = await redeemTicket(ticket);
  if (!ticketUser) {
    const reason = 'Invalid or expired ticket';
    logWarn('websocket-setup', `[WS] REJECT - ${reason}`, {
      requestId: upgradeRequestId,
      orgId: orgId || 'missing',
      ticketLength: ticket.length,
      ticketPrefix: ticket.substring(0, 10),
      pathname,
      ip,
      ticketStoreSize: getTicketStoreSize(),
    });
    writeHttpError(socket, 401, 'Unauthorized', reason);
    return;
  }

  const ticketOrgId = ticketUser.orgId || ticketUser.org_id || null;
  if (orgId && ticketOrgId && orgId !== ticketOrgId) {
    const reason = 'org_id mismatch with ticket';
    logWarn('websocket-setup', `[WS] REJECT - ${reason}`, {
      requestId: upgradeRequestId,
      requestedOrgId: orgId,
      ticketOrgId,
      pathname,
      ip,
    });
    writeHttpError(socket, 403, 'Forbidden', reason);
    return;
  }

  req.user = ticketUser;
  req.orgId = orgId || ticketOrgId;
  req.userId = ticketUser.userId || ticketUser.uid;
  req.impersonation = ticketUser.impersonation;

  if (socket.destroyed || !socket.writable) {
    const reason = 'Socket closed before upgrade';
    logWarn('websocket-setup', `[WS] REJECT - ${reason}`, {
      requestId: upgradeRequestId,
      orgId: req.orgId || 'none',
      userId: req.userId || 'none',
      socketDestroyed: socket.destroyed,
      socketWritable: socket.writable,
    });
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.orgId = req.orgId || ticketOrgId;
    ws.userId = req.userId || ticketUser.userId || ticketUser.uid;

    if (!ws.orgId || !ws.userId) {
      void logError('websocket-setup', 'WebSocket upgrade completed but missing orgId or userId', null, {
        requestId: upgradeRequestId,
        wsOrgId: ws.orgId || 'missing',
        wsUserId: ws.userId || 'missing',
        reqOrgId: req.orgId || 'missing',
        reqUserId: req.userId || 'missing',
        ticketUserUid: ticketUser.uid || 'missing',
        ticketUserId: ticketUser.userId || 'missing',
      });
      ws.close(1008, 'Missing organization or user context');
      return;
    }

    wss.emit('connection', ws, req);
  });
}

export function setupWebSockets(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', routeConnection);

  server.on('upgrade', (incomingReq, socket, head) => {
    const req = incomingReq as WebSocketUpgradeRequest;

    void (async () => {
      try {
        const { pathname, normalized, orgId, ticket } = parseUpgradeUrl(req);
        logConnectionDiagnostics(req);

        const upgradeCheck = canUpgradeToWebSocket(req);
        if (!upgradeCheck.ok) {
          void logError('websocket-setup', 'Cannot upgrade to WebSocket', {
            reason: upgradeCheck.reason,
            pathname,
          });
          writeHttpError(socket, 400, 'Bad Request', upgradeCheck.reason);
          return;
        }

        if (normalized === NOTIFICATIONS_PATH) {
          await handleNotificationUpgrade(wss, req, socket, head, pathname, orgId, ticket);
          return;
        }

        if (normalized === INFOBIP_VOICE_STREAM_PATH) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
          return;
        }

        void logError('websocket-setup', 'Unknown WebSocket upgrade path', {
          pathname,
          normalizedPathname: normalized,
          availablePaths: [NOTIFICATIONS_PATH, INFOBIP_VOICE_STREAM_PATH],
        });
        writeHttpError(socket, 404, 'Not Found', `WebSocket path not found: ${pathname || 'unknown'}`);
      } catch (error: unknown) {
        void logError('websocket-setup', 'WebSocket upgrade error', error, {
          message: getErrorMessage(error),
        });
        writeHttpError(socket, 500, 'Internal Server Error', `Internal server error: ${getErrorMessage(error)}`);
      }
    })();
  });
}

export * from './handlers/notificationsHandler.js';
export { getConnectionStats } from './utils/clientManager.js';
