import { randomUUID } from "node:crypto";
import { normalizeToolArguments } from "./openai-to-gemini.js";

export function makeOpenAIToolCallId(thoughtSignature) {
  const id = `call_${randomUUID()}`;
  if (!thoughtSignature) {
    return id;
  }
  const encodedSignature = Buffer.from(thoughtSignature, "utf8").toString(
    "base64url",
  );
  return `${id}_gts${encodedSignature}`;
}

export function getOpenAIFinishReason(reason) {
  if (reason === "MAX_TOKENS") {
    return "length";
  }
  if (reason === "SAFETY" || reason === "RECITATION") {
    return "content_filter";
  }
  return "stop";
}

export function toOpenAIResponse(data, model, tools) {
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("");
  const toolCalls = parts
    .filter((part) => part.functionCall)
    .map((part) => {
      const thoughtSignature = part.thoughtSignature ?? part.thought_signature;
      const tool = tools?.find(
        (entry) => entry.function?.name === part.functionCall.name,
      );
      const args = normalizeToolArguments(
        part.functionCall.args ?? {},
        tool?.function?.parameters,
      );
      return {
        id: makeOpenAIToolCallId(thoughtSignature),
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(args),
        },
        ...(thoughtSignature && { thought_signature: thoughtSignature }),
      };
    });
  const usage = data.usageMetadata;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length && { tool_calls: toolCalls }),
        },
        finish_reason: toolCalls.length
          ? "tool_calls"
          : getOpenAIFinishReason(candidate?.finishReason),
      },
    ],
    ...(usage && {
      usage: {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens: usage.totalTokenCount ?? 0,
      },
    }),
  };
}
