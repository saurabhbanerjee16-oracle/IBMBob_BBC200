import { loadConfig, loadDotEnv } from "../core/config.js";
import { createApp } from "./app.js";
import { MIN_SECRET_LENGTH } from "./session.js";

loadDotEnv();
const config = loadConfig();
const app = createApp(config);

const { officerUsername, officerPassword, sessionSecret, cookieSecure } = config.web;
if (!officerUsername || !officerPassword || !sessionSecret || sessionSecret.length < MIN_SECRET_LENGTH) {
  console.error(
    `Officer area disabled: set OFFICER_USERNAME, OFFICER_PASSWORD and a SESSION_SECRET of at least ${MIN_SECRET_LENGTH} characters.`,
  );
}
if (cookieSecure) {
  console.error("COOKIE_SECURE=true: officer sign-in needs HTTPS (or Chrome/Firefox on localhost). Set COOKIE_SECURE=false for plain-HTTP local demos only.");
}
if (config.vision.provider === "mock") {
  console.error("DEMO MODE: VISION_PROVIDER=mock performs no real image analysis.");
}

const server = app.listen(config.web.port, () => {
  console.error(`Web server listening on http://localhost:${config.web.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
