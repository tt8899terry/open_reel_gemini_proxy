import { Router } from "express";
import fetch from "node-fetch";
import { DEFAULT_MODEL } from "../config.js";
import { toGeminiRequest } from "../converters/openai-to-gemini.js";
import { toOpenAIResponse } from "../converters/gemini-to-openai.js";
import { relayGeminiStream } from "../converters/gemini-stream.js";

const router = Router();

function sendOpenAIError(res, status, message) {
  res.status(status).json({
    error: {
      message,
      type: "upstream_error",
    },
  });
}

router.post("/chat/completions", async (req, res) => {
  const requestedModel = req.body?.model;
  const model = requestedModel || DEFAULT_MODEL;
  if (typeof model !== "string" || !model.startsWith("gemini-")) {
    return sendOpenAIError(res, 400, "Only Gemini models are supported.");
  }

  console.log(`Proxying Gemini request using model: "${model}"`);

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
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
        "X-goog-api-key": geminiApiKey,
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

router.get("/models", (req, res) => {
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

export default router;
