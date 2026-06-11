import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import { handleCancelBookingTool } from '../booking/cancelBooking.ts';
import { handleCreateBookingTool } from '../booking/createBooking.ts';
import { handleGetAvailableSlotsTool } from '../booking/getAvailableSlots.ts';
import { handleLookupUpcomingBookingsTool } from '../booking/lookupUpcomingBookings.ts';
import { handleRescheduleBookingTool } from '../booking/rescheduleBooking.ts';
import type { RegisteredAsyncTool } from './registryTypes.ts';

export const BOOKING_TOOL_REGISTRY: Record<string, RegisteredAsyncTool> = {
  get_available_slots: {
    adkToolName: 'lookupAppointmentAvailability',
    handler: 'booking/getAvailableSlots.handleGetAvailableSlotsTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleGetAvailableSlotsTool(context.bookingToolContext(), call.args, call.id)
  },
  lookup_upcoming_bookings: {
    adkToolName: 'lookupUpcomingBookings',
    handler: 'booking/lookupUpcomingBookings.handleLookupUpcomingBookingsTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleLookupUpcomingBookingsTool(context.bookingToolContext(), call.args, call.id)
  },
  create_booking: {
    adkToolName: 'createBooking',
    handler: 'booking/createBooking.handleCreateBookingTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleCreateBookingTool(context.bookingToolContext(), call.args, call.id)
  },
  cancel_booking: {
    adkToolName: 'cancelBooking',
    handler: 'booking/cancelBooking.handleCancelBookingTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleCancelBookingTool(context.bookingToolContext(), call.args, call.id)
  },
  reschedule_booking: {
    adkToolName: 'rescheduleBooking',
    handler: 'booking/rescheduleBooking.handleRescheduleBookingTool',
    run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => handleRescheduleBookingTool(context.bookingToolContext(), call.args, call.id)
  }
};
