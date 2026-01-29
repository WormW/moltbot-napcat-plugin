import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { napcatPlugin } from "./src/channel.js";
import { setNapcatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "Napcat",
  description: "OneBot v11 channel plugin via Napcat",
  configSchema: emptyPluginConfigSchema(),
  register(api: MoltbotPluginApi) {
    setNapcatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatPlugin });
  },
};

export default plugin;
