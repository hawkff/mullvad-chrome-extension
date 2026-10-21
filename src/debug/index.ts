import { controller } from "../background/controller";
import type { CommandClient } from "../shared/messages";
export interface DevelopmentControl {
  command: CommandClient;
  version: 1;
}
declare global {
  var mullvadDev: DevelopmentControl | undefined;
}
// Worker-only CDP target: no runtime message endpoint, HTTP listener, or eval command.
if (__DEV__ && typeof document === "undefined") {
  globalThis.mullvadDev = Object.freeze({
    version: 1,
    command: controller.client.bind(controller),
  });
}
