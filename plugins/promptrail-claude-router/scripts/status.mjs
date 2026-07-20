import { loadRouterConfig, routerConfigPath } from "../src/config.mjs";

try {
  const config = await loadRouterConfig(routerConfigPath());
  const response = await fetch(`http://${config.host}:${config.port}/health`);
  if (!response.ok) {
    throw new Error(`PromptRail Claude proxy health check returned HTTP ${response.status}.`);
  }
  const health = await response.json();
  process.stdout.write(
    `${JSON.stringify({
      configured: true,
      healthy: health.status === "ok",
      proxy: `${config.host}:${config.port}`,
      mode: health.mode,
      grades: health.grades,
      grader_host: new URL(config.graderUrl).host,
    }, null, 2)}\n`,
  );
} catch (error) {
  if (error?.code === "ENOENT") {
    process.stdout.write(`${JSON.stringify({ configured: false, healthy: false, reason: "not_installed" }, null, 2)}\n`);
  } else {
    process.stderr.write(`PromptRail Claude router is not healthy: ${error.message}\n`);
    process.exitCode = 1;
  }
}
