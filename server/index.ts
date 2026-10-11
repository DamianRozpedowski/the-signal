import { createApp } from "./app.ts";
import { seedAll, startBackground } from "./bootstrap.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { log } from "./log.ts";

openDb();
const seeded = seedAll();
log("info", "startup", "Database ready", { path: config.dbPath, ...seeded });

const app = createApp();
app.listen(config.port, () => {
  log("info", "startup", `The Signal API listening on http://localhost:${config.port}`, {
    ai: config.anthropicKeyPresent ? "configured" : "not configured",
    scheduler: config.schedulerEnabled,
  });
  startBackground();
});
