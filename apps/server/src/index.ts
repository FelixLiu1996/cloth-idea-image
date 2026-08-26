import { buildApp } from "./app";
import { createGarmentProvider, loadServerConfig } from "./config";

const config = loadServerConfig();
const provider = createGarmentProvider();
const app = await buildApp({ config, provider, logger: true });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
