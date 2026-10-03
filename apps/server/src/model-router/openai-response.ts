import { createId } from "@paralleldrive/cuid2";
import type {
  ModelChatResult,
  ModelToolCall,
  OpenAIChatCompletion,
} from "@zakura/shared";

type NormalizedUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

const UNSAFE_TOOL_FINISH_REASONS = new Set(["length", "content_filter"]);

/** Tool arguments are executable only when they form one complete JSON object. */
export function hasCompleteToolArguments(argumentsText: string): boolean {
  const value = argumentsText.trim();
  if (!value) return true; // Providers commonly omit `{}` for zero-argument tools.
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export class IncompleteModelToolCallError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "IncompleteModelToolCallError";
  }
}

export function assertCompleteToolCalls(
  calls: ModelToolCall[],
  finishReason: string | null | undefined,
  observedFragments = calls.length,
): void {
  if (observedFragments === 0) return;
  if (UNSAFE_TOOL_FINISH_REASONS.has(finishReason ?? "")) {
    throw new IncompleteModelToolCallError(
      `模型工具调用因 ${finishReason} 截断，已阻止执行`,
    );
  }
  if (
    calls.length !== observedFragments ||
    calls.some(
      (call) =>
        !call.function.name.trim() ||
        !hasCompleteToolArguments(call.function.arguments),
    )
  ) {
    throw new IncompleteModelToolCallError("模型返回了不完整的工具调用参数，已阻止执行");
  }
}

function hasUsage(usage: NormalizedUsage | undefined): usage is NormalizedUsage {
  return Boolean(
    usage &&
      (usage.promptTokens != null ||
        usage.completionTokens != null ||
        usage.totalTokens != null),
  );
}

/** Build the stable Chat Completions envelope returned by every model adapter. */
export function buildOpenAIChatCompletion(input: {
  model: string;
  content: string | null;
  toolCalls?: ModelToolCall[];
  finishReason?: string | null;
  usage?: NormalizedUsage;
  id?: string;
  created?: number;
}): OpenAIChatCompletion {
  const toolCalls = input.toolCalls?.length ? input.toolCalls : undefined;
  const usage = hasUsage(input.usage)
    ? {
        prompt_tokens: input.usage.promptTokens ?? 0,
        completion_tokens: input.usage.completionTokens ?? 0,
        total_tokens:
          input.usage.totalTokens ??
          (input.usage.promptTokens ?? 0) + (input.usage.completionTokens ?? 0),
      }
    : undefined;

  return {
    id: input.id ?? `chatcmpl-${createId()}`,
    object: "chat.completion",
    created: input.created ?? Math.floor(Date.now() / 1_000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason:
          input.finishReason ?? (toolCalls ? "tool_calls" : "stop"),
      },
    ],
    usage,
  };
}

export type ChatStreamState = {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  model: string | null;
  usage?: NormalizedUsage;
};

export function createChatStreamState(): ChatStreamState {
  return {
    content: "",
    reasoning: "",
    toolCalls: [],
    finishReason: null,
    model: null,
  };
}

type StreamToolDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

function toolSlot(state: ChatStreamState, delta: StreamToolDelta) {
  let index = delta.index;
  if (index == null && delta.id) {
    const existing = state.toolCalls.findIndex((call) => call.id === delta.id);
    if (existing >= 0) index = existing;
  }
  // Some compatible gateways omit index after the opening fragment. Attach
  // those fragments to the most recent call rather than inventing extra calls.
  if (index == null) index = Math.max(0, state.toolCalls.length - 1);
  while (state.toolCalls.length <= index) {
    state.toolCalls.push({ id: "", name: "", arguments: "" });
  }
  return state.toolCalls[index]!;
}

/** Consume one Chat Completions chunk and return only its visible deltas. */
export function absorbChatStreamChunk(
  state: ChatStreamState,
  chunk: unknown,
): { content: string; reasoning: string } {
  if (!chunk || typeof chunk !== "object") return { content: "", reasoning: "" };
  const envelope = chunk as {
    model?: unknown;
    choices?: Array<{
      delta?: {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
        reasoning_text?: unknown;
        thinking?: unknown;
        tool_calls?: StreamToolDelta[];
      };
      finish_reason?: unknown;
    }>;
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  };

  if (typeof envelope.model === "string" && envelope.model) {
    state.model = envelope.model;
  }
  if (envelope.usage) {
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    state.usage = {
      promptTokens:
        number(envelope.usage.prompt_tokens) ?? state.usage?.promptTokens,
      completionTokens:
        number(envelope.usage.completion_tokens) ?? state.usage?.completionTokens,
      totalTokens: number(envelope.usage.total_tokens) ?? state.usage?.totalTokens,
    };
  }

  const choice = envelope.choices?.[0];
  if (!choice) return { content: "", reasoning: "" };
  if (typeof choice.finish_reason === "string") {
    state.finishReason = choice.finish_reason;
  }
  const delta = choice.delta;
  if (!delta) return { content: "", reasoning: "" };

  for (const fragment of delta.tool_calls ?? []) {
    const slot = toolSlot(state, fragment);
    if (fragment.id) slot.id = fragment.id;
    if (fragment.function?.name) slot.name += fragment.function.name;
    if (fragment.function?.arguments) {
      slot.arguments += fragment.function.arguments;
    }
  }

  const candidateReasoning =
    delta.reasoning_content ??
    delta.reasoning ??
    delta.reasoning_text ??
    delta.thinking;
  const reasoning =
    typeof candidateReasoning === "string" ? candidateReasoning : "";
  const content = typeof delta.content === "string" ? delta.content : "";
  if (reasoning) state.reasoning += reasoning;
  if (content) state.content += content;
  return { content, reasoning };
}

export function chatStreamStateToResult(
  state: ChatStreamState,
  fallbackModel: string,
): ModelChatResult {
  const observedCalls = state.toolCalls.filter(
    (call) => call.id || call.name || call.arguments,
  );
  const completeCalls = observedCalls.filter((call) => call.name.trim());
  // `stop` is the only explicit declaration that tools are not actionable.
  // Several compatible gateways end at EOF or send finish_reason=null.
  const includeCalls = state.finishReason !== "stop" && completeCalls.length > 0;
  const toolCalls: ModelToolCall[] | undefined = includeCalls
    ? completeCalls.map((call, index) => ({
        id: call.id || `call_${index}`,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments || "{}",
        },
      }))
    : undefined;
  assertCompleteToolCalls(
    toolCalls ?? [],
    state.finishReason,
    includeCalls ? observedCalls.length : 0,
  );
  return toModelChatResult(
    buildOpenAIChatCompletion({
      model: state.model ?? fallbackModel,
      content: state.content || null,
      toolCalls,
      finishReason: state.finishReason,
      usage: state.usage,
    }),
  );
}

export function toModelChatResult(
  openai: OpenAIChatCompletion,
  raw?: unknown,
): ModelChatResult {
  const choice = openai.choices[0];
  return {
    content: choice?.message.content ?? null,
    model: openai.model,
    finishReason: choice?.finish_reason ?? null,
    toolCalls: choice?.message.tool_calls,
    usage: openai.usage
      ? {
          promptTokens: openai.usage.prompt_tokens,
          completionTokens: openai.usage.completion_tokens,
          totalTokens: openai.usage.total_tokens,
        }
      : undefined,
    openai,
    raw,
  };
}
