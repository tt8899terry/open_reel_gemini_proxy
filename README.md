# OpenReel Gemini Proxy

An OpenAI-compatible proxy for Gemini chat completions. It translates
OpenAI-style text messages into Gemini's native `generateContent` API requests
and translates the response back to OpenAI chat-completion format.
Tool schemas that contain `fontWeight` are presented to Gemini as an integer
with guidance to use one of OpenReel's supported numeric weights (100 through
900 in increments of 100).

## Run locally

1. Install Node.js 18 or newer.
2. Install dependencies:

   ```powershell
   npm install
   ```

3. Copy `.env.example` to `.env` and set your Gemini API key.
4. Start the proxy:

   ```powershell
   npm start
   ```

connect to http://localhost:3000/v1/chat/completions using open reel

The proxy listens on `http://localhost:3000` by default. It provides
`POST /v1/chat/completions` and `GET /v1/models`. Set `PORT` in `.env` to
change the port. The proxy supports text messages, function tools, streaming,
and inline base64 image, video, and audio content. Remote media URLs are not
fetched; send media as base64 data URLs. Use a Gemini model ID such as
`gemini-3.8-flash`. If no model is provided, the proxy uses `gemini-3.8-flash`;
non-Gemini model IDs are rejected.

## Code structure

- `index.js` loads environment variables and starts the server.
- `src/app.js` configures Express middleware and mounts the API routes.
- `src/routes/api.js` handles the chat-completions and models endpoints.
- `src/converters/openai-to-gemini.js` builds Gemini requests from OpenAI-style
  requests and normalizes function arguments.
- `src/converters/gemini-to-openai.js` converts Gemini responses to
  OpenAI-compatible responses.
- `src/converters/gemini-stream.js` relays Gemini streaming responses as
  OpenAI-compatible server-sent events.
