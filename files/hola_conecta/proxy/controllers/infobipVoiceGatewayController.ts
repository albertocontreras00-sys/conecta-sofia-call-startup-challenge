import type { Request, Response } from 'express';
import { error as errorResponse, success } from '../utils/response.js';
import { logError } from '../utils/logger.js';
import { processInfobipVoiceWebhook } from '../services/voice/infobipVoiceWebhookService.ts';
import { getHeaderString, getRawBody } from '../services/voice/voiceSchemas.ts';

type RawRequest = Request & {
  rawBody?: Buffer;
};

function getErrorStatus(err: unknown): number {
  const candidate = err as { status?: number; statusCode?: number };
  const status = candidate?.status ?? candidate?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

function getErrorCode(err: unknown): string {
  const candidate = err as { code?: string; name?: string };
  return candidate?.code || candidate?.name || (getErrorStatus(err) >= 500 ? 'SOFIA_VOICE_ERROR' : 'SOFIA_VOICE_BAD_REQUEST');
}

export async function handleInfobipVoiceEvent(req: RawRequest, res: Response) {
  const raw = getRawBody(req);
  try {
    const result = await processInfobipVoiceWebhook({
      raw,
      req,
      transactionId: getHeaderString(req, 'x-infobip-transaction-id') || getHeaderString(req, 'x-request-id')
    });
    return success(res, { data: result });
  } catch (err) {
    logError('infobipVoiceGatewayController', 'Failed to process Infobip Sofia voice event', err);
    return errorResponse(
      res,
      getErrorCode(err),
      err instanceof Error ? err.message : 'Failed to process Sofia voice event',
      getErrorStatus(err),
    );
  }
}
