import { controller } from "./controller";

// Register synchronously, before storage/network initialization or dynamic imports.
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  void controller.execute(message, sender).then(respond);
  return true;
});
chrome.runtime.onInstalled.addListener(() => controller.refresh());
chrome.runtime.onStartup.addListener(() => controller.refresh());
chrome.permissions.onRemoved.addListener(() => {
  controller.privateWindowChanged();
  controller.refresh();
});
chrome.proxy.settings.onChange.addListener(() => controller.refresh());
chrome.windows.onRemoved.addListener((windowId) =>
  controller.privateWindowChanged(windowId),
);
chrome.windows.onCreated.addListener((window) =>
  controller.privateWindowCreated(window),
);
if (__DEV__) {
  void import("../debug/index");
}
