import type { GeminiFunctionDeclaration } from '../../infobipMediaWebSocketGeminiTypes.ts';

export function createCallbackTaskTool(): GeminiFunctionDeclaration {
  return {
    name: 'create_callback_task',
    description: 'Create a real Tasks app callback task only after explicit caller confirmation. The backend assigns it to the matched contact owner, or the account owner if the contact has no owner, and returns that assignee so Sofia can answer who will call back.',
    parameters: {
      type: 'object',
      properties: {
        details: {
          type: 'string',
          description: 'Concise caller-provided callback details. Do not include sensitive account details unless the caller is verified.'
        },
        confirmationReceived: {
          type: 'boolean',
          description: 'Must be true only after the caller explicitly confirms the callback request.'
        }
      },
      required: ['details', 'confirmationReceived']
    }
  };
}

export function sendSmsTool(): GeminiFunctionDeclaration {
  return {
    name: 'send_sms',
    description: 'Send a real SMS to the caller from Sofia voice only after explicit caller confirmation. Use for map links, address links, directions links, or short public business information the caller asked to receive by text. This tool actually sends the SMS; only tell the caller it was sent after this tool returns sent.',
    parameters: {
      type: 'object',
      properties: {
        body: {
          type: 'string',
          description: 'The exact SMS body to send. Keep it concise and do not include sensitive private account details.'
        },
        confirmationReceived: {
          type: 'boolean',
          description: 'Must be true only after the caller explicitly agrees to receive this SMS.'
        },
        toPhone: {
          type: 'string',
          description: 'Optional destination phone number only if the caller explicitly provides a different number. Otherwise Sofia sends to the current caller phone.'
        },
        purpose: {
          type: 'string',
          enum: ['map_link', 'directions', 'business_info', 'callback', 'other'],
          description: 'Why Sofia is sending the SMS.'
        }
      },
      required: ['body', 'confirmationReceived']
    }
  };
}

export function requestHumanFollowupTool(): GeminiFunctionDeclaration {
  return {
    name: 'request_human_followup',
    description: 'Record that Sofia must stop trying to solve the request and create a staff follow-up at call finalization. Use for unsupported requests, angry or urgent callers, specific staff requests, restricted advice, portal access problems, or unsafe identity cases.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: [
            'unsupported_request',
            'specific_human_requested',
            'caller_angry_or_urgent',
            'ambiguous_identity',
            'important_tool_failure',
            'restricted_advice_or_judgment',
            'repeated_failed_attempts',
            'document_signature_status_confusing',
            'portal_access_problem',
            'callback_request'
          ],
          description: 'The deterministic escalation reason.'
        },
        topic: {
          type: 'string',
          description: 'Short non-sensitive topic or requested person. Do not include tax/legal/private facts unless verified.'
        }
      },
      required: ['reason', 'topic']
    }
  };
}

export function lookupBusinessInfoTool(): GeminiFunctionDeclaration {
  return {
    name: 'lookup_business_info',
    description: 'Read verified public business facts for this org, such as office address, hours, phone, email, website, directions/parking availability, nearby landmarks, map links, service/pricing source status, walk-ins, payment methods, refund/balance policy source status, languages, staff, or preparer availability. Use before answering any office location, address, hours, phone, email, website, service, pricing, walk-in, payment, refund, staff, preparer, parking, landmark, map link, or directions question. If the tool says unavailable, Sofia must say the verified answer is not available and offer to take a message or request follow-up. Never invent business facts or landmarks.',
    parameters: {
      type: 'object',
      properties: {
        questionType: {
          type: 'string',
          enum: [
            'office_address',
            'office_hours',
            'directions',
            'parking',
            'nearby_landmark',
            'map_link_request',
            'phone_number',
            'email',
            'website',
            'services_offered',
            'pricing',
            'documents_needed',
            'appointment_availability',
            'walk_ins',
            'languages_spoken',
            'payment_methods',
            'refunds_or_balances',
            'staff',
            'specific_preparer',
            'general'
          ],
          description: 'The business fact the caller asked for.'
        },
        requestedPersonName: {
          type: 'string',
          description: 'Specific staff/preparer name the caller asked about, when applicable.'
        },
        requestedLocationName: {
          type: 'string',
          description: 'Specific office/location name the caller asked about, when applicable.'
        },
        generalStartingPoint: {
          type: 'string',
          description: 'Only include a broad starting point the caller voluntarily provided, such as a city, neighborhood, or major intersection. Do not ask for or store precise caller location.'
        }
      },
      required: ['questionType']
    }
  };
}

export function listCallerDocumentsTool(): GeminiFunctionDeclaration {
  return {
    name: 'list_caller_documents',
    description: 'Read sanitized document request and upload status summaries for the matched caller. Never returns file contents, download links, or signed URLs.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum document status summaries to return, capped by the backend.'
        }
      }
    }
  };
}

export function listPendingSignaturesTool(): GeminiFunctionDeclaration {
  return {
    name: 'list_pending_signatures',
    description: 'Read sanitized pending e-signature envelope status for the matched caller. Never returns signing links, tokens, or document contents.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum pending signature summaries to return, capped by the backend.'
        }
      }
    }
  };
}
