function getInlineData(url) {
  if (typeof url !== "string") {
    throw new Error("Media content must use a base64 data URL.");
  }

  const match =
    /^data:(image\/[^;,]+|video\/[^;,]+|audio\/[^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
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
    throw new Error(
      "Message content must be text or an array of content parts.",
    );
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
      (["image", "video", "audio"].includes(part?.type) ? part.url : undefined);
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
        throw new Error(
          "Media source must contain a valid base64 MIME type and data.",
        );
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
    throw new Error(
      "System instructions and tool results must contain text only.",
    );
  }
  return parts.map((part) => part.text).join("");
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

function sanitizeFunctionSchema(schema, propertyName) {
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
  if (propertyName === "fontWeight") {
    description = [
      description,
      "Use a numeric font weight, not an object or string. Choose one of: 100, 200, 300, 400, 500, 600, 700, 800, 900.",
    ]
      .filter(Boolean)
      .join(" ");
    result.type = "INTEGER";
    result.description = description;
    return result;
  }
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
        sanitizeFunctionSchema(property, name),
      ]),
    );
  }
  if (Array.isArray(schema.required)) {
    result.required = schema.required;
  }
  return result;
}

export function normalizeToolArguments(value, schema) {
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

/**
 * Open Reel sends an OpenAI-style chat request, but Gemini expects conversation
 * turns as `contents` and uses different fields for system instructions, tools,
 * and generation settings. Map the supported options into Gemini's shape so the
 * proxy can keep Open Reel's request interface while calling `generateContent`.
 *
 * Open Reel integration setup: ../../README.md#run-locally
 * OpenAI request format: https://platform.openai.com/docs/api-reference/chat/create
 * Gemini request format: https://ai.google.dev/api/generate-content
 * Gemini function calling: https://ai.google.dev/gemini-api/docs/function-calling
 */
export function toGeminiRequest(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("Request must include a non-empty messages array.");
  }

  const systemParts = [];
  const contents = [];
  const toolNamesById = new Map();
  for (const message of body.messages) {
    if (message.role === "system" || message.role === "developer") {
      // Gemini keeps these instructions outside the conversation turns.
      systemParts.push({ text: getTextContent(message.content) });
    } else if (message.role === "user") {
      contents.push({
        role: "user",
        parts: getGeminiParts(message.content),
      });
    } else if (message.role === "assistant") {
      // Gemini calls the assistant role "model"; text and function calls share
      // the same parts array so tool calls stay in their original turn.
      const parts = [];
      if (message.content !== null && message.content !== undefined) {
        parts.push(...getGeminiParts(message.content));
      }
      for (const toolCall of message.tool_calls ?? []) {
        // Gemini's functionResponse identifies a tool by name, while OpenAI
        // pairs results with an ID, so remember the name for the next turn.
        toolNamesById.set(toolCall.id, toolCall.function.name);
        let args;
        try {
          // OpenAI serializes function arguments as JSON text; Gemini expects
          // the decoded value as the functionCall's args object.
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
      // Gemini represents a tool result as a user turn containing a
      // functionResponse, rather than as a separate tool-role turn.
      const name = message.name ?? toolNamesById.get(message.tool_call_id);
      if (!name) {
        throw new Error("Tool result is missing its matching tool call name.");
      }
      const content = getTextContent(message.content);
      let response;
      try {
        response = JSON.parse(content);
      } catch {
        // Keep plain-text tool output usable by wrapping it in an object,
        // which is Gemini's expected functionResponse shape.
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

  // Gemini rejects a generateContent request without at least one conversation
  // turn; system instructions alone do not count as a turn.
  if (contents.length === 0) {
    throw new Error(
      "Request must include at least one user or assistant message.",
    );
  }

  // Translate OpenAI parameter names into Gemini's generationConfig fields.
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
