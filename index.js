import cors from "cors";
import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { randomUUID } from "node:crypto";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1000mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = "gemini-3.8-flash";

function makeOpenAIToolCallId(thoughtSignature) {
  const id = `call_${randomUUID()}`;
  if (!thoughtSignature) {
    return id;
  }
  const encodedSignature = Buffer.from(thoughtSignature, "utf8").toString(
    "base64url",
  );
  return `${id}_gts${encodedSignature}`;
}

function getThoughtSignature(toolCall) {
  if (
    typeof toolCall.thought_signature === "string" &&
    toolCall.thought_signature
  ) {
    return toolCall.thought_signature;
  }
  if (
    typeof toolCall.thoughtSignature === "string" &&
    toolCall.thoughtSignature
  ) {
    return toolCall.thoughtSignature;
  }

  const match = /_gts([A-Za-z0-9_-]+)$/.exec(toolCall.id ?? "");
  return match
    ? Buffer.from(match[1], "base64url").toString("utf8")
    : undefined;
}

function getInlineData(url) {
  if (typeof url !== "string") {
    throw new Error("Media content must use a base64 data URL.");
  }

  const match = /^data:(image\/[^;,]+|video\/[^;,]+|audio\/[^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    url,
  );
  if (!match) {
    throw new Error(
      "Only base64 image, video, or audio data URLs are supported; remote media URLs are not fetched.",
    );
  }

  const data = match[2].replace(/\s/g, "");
  if (!data || data.length % 4 === 1) {
    throw new Error("Media contains invalid base64 data.");
  }
  return { inlineData: { mimeType: match[1], data } };
}

function getGeminiParts(content) {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  if (!Array.isArray(content)) {
    throw new Error("Message content must be text or an array of content parts.");
  }

  return content.map((part) => {
    if (typeof part === "string") {
      return { text: part };
    }
    if (
      ["text", "input_text", "output_text"].includes(part?.type) &&
      typeof part.text === "string"
    ) {
      return { text: part.text };
    }

    const mediaUrl =
      part?.image_url?.url ??
      part?.video_url?.url ??
      (typeof part?.image_url === "string" ? part.image_url : undefined) ??
      (typeof part?.video_url === "string" ? part.video_url : undefined) ??
      (["image", "video", "audio"].includes(part?.type)
        ? part.url
        : undefined);
    if (mediaUrl) {
      return getInlineData(mediaUrl);
    }

    if (part?.source?.type === "base64") {
      const mediaType = part.source.media_type;
      const data = part.source.data;
      if (
        typeof mediaType !== "string" ||
        !/^(image|video|audio)\//i.test(mediaType) ||
        typeof data !== "string" ||
        !data
      ) {
        throw new Error("Media source must contain a valid base64 MIME type and data.");
      }
      return { inlineData: { mimeType: mediaType, data } };
    }

    throw new Error(
      `Unsupported message content part "${part?.type ?? "unknown"}". Use text or base64 image/video/audio content.`,
    );
  });
}

function getTextContent(content) {
  const parts = getGeminiParts(content);
  if (parts.some((part) => !part.text)) {
    throw new Error("System instructions and tool results must contain text only.");
  }
  return parts.map((part) => part.text).join("");
}

function sanitizeFunctionSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "OBJECT", properties: {} };
  }

  const result = {};
  if (typeof schema.type === "string") {
    result.type = schema.type.toUpperCase();
  } else {
    result.type = "OBJECT";
  }
  let description =
    typeof schema.description === "string" ? schema.description : "";
  const numericEnum =
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((value) => typeof value === "number");
  if (numericEnum && result.type === "OBJECT") {
    result.type = schema.enum.every(Number.isInteger) ? "INTEGER" : "NUMBER";
  }
  if (
    result.type === "STRING" &&
    Array.isArray(schema.enum) &&
    schema.enum.every((value) => typeof value === "string")
  ) {
    result.enum = schema.enum;
  } else if (numericEnum) {
    description = [
      description,
      `Choose a numeric value from this exact list: ${schema.enum.join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (description) {
    result.description = description;
  }
  if (schema.items) {
    result.items = sanitizeFunctionSchema(schema.items);
  }
  if (schema.properties && typeof schema.properties === "object") {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        sanitizeFunctionSchema(property),
      ]),
    );
  }
  if (Array.isArray(schema.required)) {
    result.required = schema.required;
  }
  return result;
}

function normalizeToolArguments(value, schema) {
  if (!schema || typeof schema !== "object") {
    return value;
  }

  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((option) => typeof option === "number")
  ) {
    const numericValue =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(numericValue)) {
      return schema.enum[Math.floor(schema.enum.length / 2)];
    }
    return schema.enum.reduce((nearest, option) =>
      Math.abs(option - numericValue) < Math.abs(nearest - numericValue)
        ? option
        : nearest,
    );
  }

  if (
    schema.type === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    schema.properties
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [
        key,
        normalizeToolArguments(childValue, schema.properties[key]),
      ]),
    );
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    return value.map((item) => normalizeToolArguments(item, schema.items));
  }

  return value;
}

function toGeminiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  const functionDeclarations = tools.map((tool) => {
    if (tool.type !== "function" || !tool.function?.name) {
      throw new Error("Only OpenAI function tools are supported.");
    }
    const declaration = {
      name: tool.function.name,
      parameters: sanitizeFunctionSchema(tool.function.parameters),
    };
    if (typeof tool.function.description === "string") {
      declaration.description = tool.function.description;
    }
    return declaration;
  });

  return [{ functionDeclarations }];
}

function toGeminiRequest(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("Request must include a non-empty messages array.");
  }

  const systemParts = [];
  const contents = [];
  const toolNamesById = new Map();
  for (const message of body.messages) {
    if (message.role === "system" || message.role === "developer") {
      systemParts.push({ text: getTextContent(message.content) });
    } else if (message.role === "user") {
      contents.push({
        role: "user",
        parts: getGeminiParts(message.content),
      });
    } else if (message.role === "assistant") {
      const parts = [];
      if (message.content !== null && message.content !== undefined) {
        parts.push(...getGeminiParts(message.content));
      }
      for (const toolCall of message.tool_calls ?? []) {
        toolNamesById.set(toolCall.id, toolCall.function.name);
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          throw new Error(
            `Assistant tool call "${toolCall.function.name}" has invalid JSON arguments.`,
          );
        }
        const thoughtSignature = getThoughtSignature(toolCall);
        parts.push({
          functionCall: { name: toolCall.function.name, args },
          ...(thoughtSignature && { thoughtSignature }),
        });
      }
      if (!parts.length) {
        throw new Error("Assistant messages must contain text or tool calls.");
      }
      contents.push({ role: "model", parts });
    } else if (message.role === "tool") {
      const name = message.name ?? toolNamesById.get(message.tool_call_id);
      if (!name) {
        throw new Error("Tool result is missing its matching tool call name.");
      }
      const content = getTextContent(message.content);
      let response;
      try {
        response = JSON.parse(content);
      } catch {
        response = { result: content };
      }
      if (
        !response ||
        typeof response !== "object" ||
        Array.isArray(response)
      ) {
        response = { result: response };
      }
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response } }],
      });
    } else {
      throw new Error(`Unsupported message role: ${message.role}`);
    }
  }
  if (contents.length === 0) {
    throw new Error(
      "Request must include at least one user or assistant message.",
    );
  }

  const generationConfig = {};
  if (typeof body.temperature === "number") {
    generationConfig.temperature = body.temperature;
  }
  if (typeof body.top_p === "number") {
    generationConfig.topP = body.top_p;
  }
  if (typeof body.max_completion_tokens === "number") {
    generationConfig.maxOutputTokens = body.max_completion_tokens;
  } else if (typeof body.max_tokens === "number") {
    generationConfig.maxOutputTokens = body.max_tokens;
  }
  if (body.stop !== undefined) {
    generationConfig.stopSequences = Array.isArray(body.stop)
      ? body.stop
      : [body.stop];
  }
  if (body.response_format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  }

  const request = { contents };
  const tools = toGeminiTools(body.tools);
  if (tools) {
    const toolConfig = {};
    if (body.tool_choice === "none") {
      toolConfig.functionCallingConfig = { mode: "NONE" };
    } else if (body.tool_choice === "required") {
      toolConfig.functionCallingConfig = { mode: "ANY" };
    } else if (
      body.tool_choice &&
      typeof body.tool_choice === "object" &&
      body.tool_choice.function?.name
    ) {
      toolConfig.functionCallingConfig = {
        mode: "ANY",
        allowedFunctionNames: [body.tool_choice.function.name],
      };
    }
    request.tools = tools;
    if (Object.keys(toolConfig).length) {
      request.toolConfig = toolConfig;
    }
  }

  if (systemParts.length) {
    request.systemInstruction = { parts: systemParts };
  }
  if (Object.keys(generationConfig).length) {
    request.generationConfig = generationConfig;
  }
  return request;
}

function getOpenAIFinishReason(reason) {
  if (reason === "MAX_TOKENS") {
    return "length";
  }
  if (reason === "SAFETY" || reason === "RECITATION") {
    return "content_filter";
  }
  return "stop";
}

function toOpenAIResponse(data, model, tools) {
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

function sendOpenAIError(res, status, message) {
  res.status(status).json({
    error: {
      message,
      type: "upstream_error",
    },
  });
}

async function relayGeminiStream(response, res, model, tools) {
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

app.post("/v1/chat/completions", async (req, res) => {
  const requestedModel = req.body?.model;
  const model = requestedModel || DEFAULT_MODEL;
  if (typeof model !== "string" || !model.startsWith("gemini-")) {
    return sendOpenAIError(res, 400, "Only Gemini models are supported.");
  }

  console.log(`Proxying Gemini request using model: "${model}"`);

  if (!GEMINI_API_KEY) {
    return sendOpenAIError(res, 500, "GEMINI_API_KEY is not configured.");
  }

  let geminiRequest;
  try {
    geminiRequest = toGeminiRequest(req.body);
  } catch (error) {
    return sendOpenAIError(res, 400, error.message);
  }

  const action = req.body.stream
    ? "streamGenerateContent?alt=sse"
    : "generateContent";
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(model)}:${action}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(geminiRequest),
    });

    if (req.body.stream && response.ok) {
      await relayGeminiStream(response, res, model, req.body.tools);
      return;
    }

    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      console.error(
        `Gemini returned a non-JSON response (${response.status} ${response.statusText}).`,
      );
      return sendOpenAIError(
        res,
        response.ok ? 502 : response.status,
        "Gemini returned a non-JSON response.",
      );
    }

    if (!response.ok) {
      console.error(`Gemini upstream error ${response.status}:`, data);
      return sendOpenAIError(
        res,
        response.status,
        data.error?.message ?? "Gemini request failed.",
      );
    }

    return res.json(toOpenAIResponse(data, model, req.body.tools));
  } catch (error) {
    console.error("Proxy Error:", error);
    if (res.headersSent) {
      return res.end();
    }
    return sendOpenAIError(res, 502, "Could not reach Gemini.");
  }
});

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "gemini-3.8-flash",
        object: "model",
        created: 1710000000,
        owned_by: "google",
      },
    ],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gemini proxy running on port ${PORT}`);
});
