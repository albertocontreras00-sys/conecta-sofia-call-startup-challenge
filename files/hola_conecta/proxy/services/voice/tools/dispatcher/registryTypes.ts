import type { DispatchGeminiToolContext, GeminiToolCall } from './dispatchTypes.ts';
import type { SophiaAdkToolName } from '../../../../sofia/adk/types.ts';

export type RegisteredAsyncTool = {
  adkToolName?: SophiaAdkToolName;
  resolveAdkToolName?: (call: GeminiToolCall) => SophiaAdkToolName | null;
  handler: string;
  run: (context: DispatchGeminiToolContext, call: GeminiToolCall) => Promise<void>;
};
