import "dotenv/config";
import { createApp } from "./src/app.js";

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Gemini proxy running on port ${PORT}`);
});
