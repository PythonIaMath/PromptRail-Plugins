import { loadRouterConfig, routerConfigPath } from "../src/config.mjs";

try {
  const config = await loadRouterConfig(routerConfigPath());
  const healthUrl = `http://${config.host}:${config.port}/health`;
  const health = await fetch(healthUrl);
  const payload = await health.json();
  process.stdout.write(
    `${JSON.stringify(
      {
        configured: true,
        healthy: health.ok && payload.status === "ok",
        proxy: `${config.host}:${config.port}`,
        mode: payload.mode,
        grades: payload.grades,
        grader_host: new URL(config.graderUrl).host,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  if (error?.code === "ENOENT") {
    process.stdout.write(`${JSON.stringify({ configured: false, healthy: false, reason: "not_installed" }, null, 2)}\n`);
  } else {
    process.stderr.write(`PromptRail router is not healthy: ${error.message}\n`);
    process.exitCode = 1;
  }
}
