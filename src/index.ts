import { websocket } from "hono/bun";
import { loadConfig } from "./config";
import { bootstrap } from "./bootstrap";

const config = await loadConfig();
const { app, port } = await bootstrap(config);

export default {
  port,
  fetch: app.fetch,
  websocket,
};
