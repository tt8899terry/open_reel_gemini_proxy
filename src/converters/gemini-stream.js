import { normalizeToolArguments } from "./openai-to-gemini.js";
import {
  getOpenAIFinishReason,
  makeOpenAIToolCallId,
} from "./gemini-to-openai.js";

export async function relayGeminiStream(response, res, model, tools) {
  const completionId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let buffer = "";
  const writeEvent = (line) => {
    if (!line.startsWith("data:")) {
      return;
    }
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") {
      return;
    }

    const event = JSON.parse(data);
    const candidate = event.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    const text = parts.map((part) => part.text ?? "").join("");
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part, index) => {
        const thoughtSignature =
          part.thoughtSignature ?? part.thought_signature;
        const tool = tools?.find(
          (entry) => entry.function?.name === part.functionCall.name,
        );
        const args = normalizeToolArguments(
          part.functionCall.args ?? {},
          tool?.function?.parameters,
        );
        return {
          index,
          id: makeOpenAIToolCallId(thoughtSignature),
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(args),
          },
          ...(thoughtSignature && { thought_signature: thoughtSignature }),
        };
      });
    const chunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            ...(text && { content: text }),
            ...(toolCalls.length && { tool_calls: toolCalls }),
          },
          finish_reason: toolCalls.length
            ? "tool_calls"
            : candidate?.finishReason
              ? getOpenAIFinishReason(candidate.finishReason)
              : null,
        },
      ],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  for await (const data of response.body) {
    buffer += data.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      writeEvent(line);
    }
  }
  if (buffer) {
    writeEvent(buffer);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}
