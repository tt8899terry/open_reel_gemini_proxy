import cors from "cors";
import express from "express";
import apiRouter from "./routes/api.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1000mb" }));
  app.use("/v1", apiRouter);
  return app;
}
