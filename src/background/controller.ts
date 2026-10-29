import * as core from "../core/index";
import type { Command, CommandResult, Response } from "../shared/messages";
import {
  type BrowserContext,
  INTERNAL_DEFAULT_SERVER_ID,
  type PrivacyStatus,
  type ProxyOwnership,
  type ProxyStatus,
  type Server,
  type Snapshot,
} from "../shared/state";
import { proxyStatus } from "../shared/status";
import { emptyDiagnostics, runDiagnostics } from "./diagnostics";
import { object, requestJson } from "./platform";
import {
  defaults,
  read,
  type Session,
  type Stored,
  validateStored,
  validPool,
  write,
} from "./storage";

class Failure extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "permission-denied"
      | "blocked"
      | "offline"
      | "internal",
    message: string,
  ) {
    super(message);
  }
}
const STATE = "state.v1";
const SESSION = "session.v1";
const CACHE = "servers.v1";
// icon-off-*.png are icon.svg rendered with the globe stroke set to #8a9bb0.
// setIcon resolves relative paths against background/, so these start at the root.
const TOOLBAR_ICONS = {
  on: { 16: "/icons/icon-16.png", 32: "/icons/icon-32.png" },
  off: { 16: "/icons/icon-off-16.png", 32: "/icons/icon-off-32.png" },
};
type Setting = chrome.types.ChromeSettingGetResult<unknown>;
function ownership(input: unknown): ProxyOwnership {
  return input === "not_controllable" ||
    input === "controlled_by_other_extensions" ||
    input === "controllable_by_this_extension" ||
    input === "controlled_by_this_extension"
    ? input
    : "unknown";
}
function proxySetting(context: BrowserContext): Promise<Setting> {
  return chrome.proxy.settings.get({ incognito: context === "incognito" });
}
function isPac(setting: Setting, data: string): boolean {
  const value = setting.value;
  return (
    setting.levelOfControl === "controlled_by_this_extension" &&
    object(value) &&
    value.mode === "pac_script" &&
    object(value.pacScript) &&
    value.pacScript.data === data &&
    value.pacScript.mandatory === true
  );
}
function isDirectOverride(setting: Setting): boolean {
  return (
    setting.levelOfControl === "controlled_by_this_extension" &&
    Boolean(setting.incognitoSpecific) &&
    object(setting.value) &&
    setting.value.mode === "direct"
  );
}
export function trustedSender(
  sender: chrome.runtime.MessageSender,
  context: BrowserContext,
): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== "chrome-extension:" ||
    url.host !== chrome.runtime.id ||
    !["/popup.html", "/options.html"].includes(url.pathname)
  )
    return false;
  // Content scripts cannot acquire a privileged extension-page URL.
  if (sender.tab?.url && !sender.tab.url.startsWith(chrome.runtime.getURL("/")))
    return false;
  // Chrome's spanning popup has no sender.tab; UI must supply its window context.
  return (
    !sender.tab || Boolean(sender.tab.incognito) === (context === "incognito")
  );
}
export class Controller {
  constructor(
    private readonly routingCore: Pick<
      typeof core,
      "generatePac" | "validateCommand" | "validateImport" | "validateServers"
    > = core,
  ) {}
  private tail: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private state = defaults();
  private session: Session = { seed: "", pool: [] };
  private servers: Snapshot["servers"] = { status: "unknown" };
  private privateEpoch = 0;
  private startupError = false;
  private privateWindows = new Set<number>();
  private allowed(): Promise<boolean> {
    return chrome.extension.isAllowedIncognitoAccess();
  }
  private async privateOpen(): Promise<boolean> {
    return (await chrome.windows.getAll({})).some((window) => window.incognito);
  }
  private async privateUsable(): Promise<boolean> {
    return (await this.allowed()) && (await this.privateOpen());
  }
  private permission(name: "proxy" | "privacy"): Promise<boolean> {
    return chrome.permissions.contains({ permissions: [name] });
  }
  private saveSession(): Promise<void> {
    return write(chrome.storage.session, SESSION, this.session);
  }
  private async savePrivateWindows(): Promise<void> {
    if (!this.session.privateState) return;
    this.session.privateWindows = [...this.privateWindows];
    await this.saveSession();
  }
  private async endPrivate(): Promise<void> {
    delete this.session.privateState;
    delete this.session.privateSeed;
    delete this.session.privateWindows;
    // Before initialization this.session is a placeholder that must not replace the stored seed.
    if (this.initialized) await this.saveSession();
  }
  private async clearPrivateOverride(): Promise<void> {
    const setting = await proxySetting("incognito");
    if (
      setting.levelOfControl === "controlled_by_this_extension" &&
      setting.incognitoSpecific
    )
      await chrome.proxy.settings.clear({ scope: "incognito_session_only" });
  }
  // Runs after every earlier queued task; a failed task does not stall later ones.
  private queued<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => undefined).then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private enqueue(task: () => Promise<void>): void {
    this.queued(task).catch(() => undefined);
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const cache = await read(chrome.storage.local, CACHE);
    if (cache !== undefined) {
      try {
        // Caches written before fetch times were stored are plain lists.
        const { value, updatedAt } = object(cache)
          ? cache
          : { value: cache, updatedAt: 0 };
        if (typeof updatedAt !== "number" || !Number.isSafeInteger(updatedAt))
          throw new Error("Invalid server cache");
        this.servers = { status: "ready", value: validPool(value), updatedAt };
      } catch {
        this.servers = {
          status: "error",
          message: "The saved server list is damaged. Refresh it.",
        };
      }
    }
    this.privateWindows = new Set(
      (await chrome.windows.getAll({}))
        .filter((window) => window.incognito && window.id !== undefined)
        .map((window) => window.id as number),
    );
    const rawSession = await read(chrome.storage.session, SESSION);
    if (
      object(rawSession) &&
      typeof rawSession.seed === "string" &&
      /^[a-f0-9-]{36}$/.test(rawSession.seed)
    ) {
      try {
        this.session = {
          seed: rawSession.seed,
          pool: validPool(rawSession.pool),
        };
      } catch {
        throw new Failure(
          "internal",
          "The saved random locations are damaged. Restart Chrome to reset them.",
        );
      }
    } else this.session = { seed: crypto.randomUUID(), pool: this.catalog() };
    const saved = await read(chrome.storage.local, STATE);
    try {
      if (saved !== undefined) this.state = validateStored(saved);
    } catch {
      this.startupError = true;
      throw new Failure(
        "internal",
        "Your saved settings couldn't be read. The proxy and settings weren't changed.",
      );
    }
    if (
      object(rawSession) &&
      rawSession.privateState !== undefined &&
      (await this.allowed()) &&
      Array.isArray(rawSession.privateWindows) &&
      rawSession.privateWindows.some(
        (id: unknown) => typeof id === "number" && this.privateWindows.has(id),
      ) &&
      typeof rawSession.privateSeed === "string" &&
      /^[a-f0-9-]{36}$/.test(rawSession.privateSeed) &&
      (await this.privateOpen())
    ) {
      this.session.privateSeed = rawSession.privateSeed;
      this.session.privateWindows = [...this.privateWindows];
      this.session.privateState = validateStored(rawSession.privateState);
    }
    await this.saveSession();
    this.initialized = true;
    if (!this.startupError) {
      // Chrome retains PAC across worker suspension; reconcile only validated state.
      await this.reconcile(this.state, "regular", false);
    }
  }
  private catalog(): Server[] {
    return this.servers.status === "ready"
      ? this.servers.value
      : this.session.pool;
  }
  private scope(context: BrowserContext): "regular" | "incognito_session_only" {
    return context === "regular" ? "regular" : "incognito_session_only";
  }
  private active(state: Stored): boolean {
    const routing = state.settings.routing;
    return (
      routing.enabled ||
      routing.randomMode ||
      routing.rules.some((rule) => rule.enabled)
    );
  }
  private pac(state: Stored, context: BrowserContext): string {
    return this.routingCore.generatePac({
      settings: state.settings.routing,
      servers: state.settings.routing.randomMode
        ? this.session.pool
        : this.catalog(),
      sessionSeed:
        context === "incognito" && this.session.privateSeed
          ? this.session.privateSeed
          : this.session.seed,
    });
  }
  private async effective(context: BrowserContext): Promise<ProxyStatus> {
    const result: ProxyStatus = {
      scope: context,
      settingScope: "unknown",
      ownership: "unknown",
      permissionGranted: await this.permission("proxy"),
      applied: false,
      status: "blocked",
    };
    if (!result.permissionGranted) {
      result.message = "Chrome hasn't granted the proxy permission.";
      return result;
    }
    if (context === "incognito" && !(await this.allowed())) {
      result.message = "Turn on Allow in Incognito in the extension's details.";
      return result;
    }
    try {
      const setting = await proxySetting(context);
      result.ownership = ownership(setting.levelOfControl);
      const privateState =
        context === "incognito" ? this.session.privateState : undefined;
      const expected = privateState ?? this.state;
      result.applied =
        this.active(expected) &&
        isPac(setting, this.pac(expected, privateState ? context : "regular"));
      if (result.applied)
        result.settingScope =
          context === "incognito" && setting.incognitoSpecific
            ? "incognito_session_only"
            : "regular";
      else if (privateState && isDirectOverride(setting))
        result.settingScope = "incognito_session_only";
      result.status =
        result.ownership === "controlled_by_other_extensions" ||
        result.ownership === "not_controllable"
          ? "blocked"
          : "ready";
      if (result.status === "blocked")
        result.message =
          "Another extension or a Chrome policy controls the proxy setting.";
      else if (this.active(expected) && !result.applied) {
        result.status = "error";
        result.message = "Chrome isn't using your saved routing.";
      }
    } catch {
      result.status = "error";
      result.message = "Chrome didn't report its proxy setting.";
    }
    return result;
  }
  private async reconcile(
    state: Stored,
    context: BrowserContext,
    strict: boolean,
  ): Promise<void> {
    const current = await this.effective(context);
    if (!current.permissionGranted || current.status === "blocked") {
      if (strict)
        throw new Failure(
          "blocked",
          current.message ??
            "Chrome won't let this extension control the proxy.",
        );
      return;
    }
    if (this.active(state)) {
      const data = this.pac(state, context);
      if (isPac(await proxySetting(context), data)) return;
      await chrome.proxy.settings.set({
        value: { mode: "pac_script", pacScript: { data, mandatory: true } },
        scope: this.scope(context),
      });
      if (!isPac(await proxySetting(context), data))
        throw new Failure("blocked", "Chrome didn't accept the new routing.");
    } else if (context === "incognito") {
      if (isDirectOverride(await proxySetting(context))) return;
      await chrome.proxy.settings.set({
        value: { mode: "direct" },
        scope: "incognito_session_only",
      });
      if (!isDirectOverride(await proxySetting(context)))
        throw new Failure(
          "blocked",
          "Chrome didn't accept the Incognito routing.",
        );
    } else if (current.ownership === "controlled_by_this_extension") {
      // An inherited regular setting must not be cleared from the private scope.
      await chrome.proxy.settings.clear({ scope: this.scope(context) });
    }
  }
  private async reconcileAll(): Promise<void> {
    if (!(await this.privateUsable())) await this.endPrivate();
    await this.reconcile(this.state, "regular", false);
    if (this.session.privateState)
      await this.reconcile(this.session.privateState, "incognito", false);
  }
  private async privacy(): Promise<PrivacyStatus> {
    const result: PrivacyStatus = {
      permissionGranted: await this.permission("privacy"),
      webRtc: { ownership: "unknown", value: null },
      networkPrediction: { ownership: "unknown", value: null },
    };
    if (!result.permissionGranted) return result;
    const [rtc, prediction] = await Promise.all([
      chrome.privacy.network.webRTCIPHandlingPolicy.get({}),
      chrome.privacy.network.networkPredictionEnabled.get({}),
    ]);
    result.webRtc = {
      ownership: ownership(rtc.levelOfControl),
      value: typeof rtc.value === "string" ? rtc.value : null,
    };
    result.networkPrediction = {
      ownership: ownership(prediction.levelOfControl),
      value: typeof prediction.value === "boolean" ? prediction.value : null,
    };
    return result;
  }
  private async snapshot(
    context: BrowserContext,
    diagnostics = emptyDiagnostics(),
  ): Promise<Snapshot> {
    const state =
      context === "incognito"
        ? (this.session.privateState ?? this.state)
        : this.state;
    const proxy = await this.effective("regular");
    const incognitoProxy: ProxyStatus =
      context === "incognito"
        ? await this.effective("incognito")
        : {
            scope: "incognito",
            settingScope: "unknown",
            ownership: "unknown",
            permissionGranted: false,
            applied: false,
            status: "unknown",
            message:
              "Private proxy settings are not inspected from regular windows.",
          };
    await this.updateToolbar(proxy);
    const settings = structuredClone(state.settings);
    settings.preferences.autoReload =
      this.state.settings.preferences.autoReload;
    return {
      context,
      incognitoAllowed: await this.allowed(),
      revision: state.revision,
      settings,
      history: context === "incognito" ? [] : structuredClone(state.history),
      // Favorites are shared with regular windows, like the reload preference.
      favorites: structuredClone(this.state.favorites),
      servers: structuredClone(this.servers),
      proxy,
      incognitoProxy,
      privacy: await this.privacy(),
      diagnostics,
    };
  }
  private async save(
    next: Stored,
    context: BrowserContext,
    routing: boolean,
  ): Promise<void> {
    const epoch = this.privateEpoch;
    const hadPrivateState = Boolean(this.session.privateState);
    const previous =
      context === "incognito"
        ? (this.session.privateState ?? this.state)
        : this.state;
    if (context === "incognito" && !(await this.privateUsable()))
      throw new Failure("blocked", "Open an Incognito window first.");
    try {
      if (context === "incognito") {
        this.session.privateSeed ??= crypto.randomUUID();
        this.session.privateWindows = [...this.privateWindows];
      }
      if (routing || (context === "incognito" && !this.session.privateState))
        await this.reconcile(next, context, true);
      if (context === "regular") {
        await write(chrome.storage.local, STATE, next);
        this.state = next;
      } else {
        if (epoch !== this.privateEpoch || !(await this.privateOpen()))
          throw new Failure(
            "blocked",
            "Incognito closed before the change was saved.",
          );
        const session = {
          ...this.session,
          privateState: { ...next, history: [] },
        };
        await write(chrome.storage.session, SESSION, session);
        this.session = session;
        if (epoch !== this.privateEpoch || !(await this.privateUsable())) {
          await this.endPrivate();
          throw new Failure(
            "blocked",
            "Incognito closed before the change was saved.",
          );
        }
      }
    } catch (error) {
      if (
        routing &&
        (context === "regular" ||
          (epoch === this.privateEpoch && (await this.privateUsable())))
      )
        if (context === "incognito" && !hadPrivateState) {
          await this.clearPrivateOverride();
          delete this.session.privateSeed;
          delete this.session.privateWindows;
        } else await this.reconcile(previous, context, false);
      throw error;
    }
  }
  // The toolbar button is shared by every window, so it shows regular routing only.
  private async updateToolbar(proxy: ProxyStatus): Promise<void> {
    const routing = this.state.settings.routing;
    const { tone, detail } = proxyStatus(proxy, routing, this.catalog());
    const exit =
      routing.enabled && !routing.randomMode
        ? this.catalog().find((row) => row.id === routing.globalServerId)
        : undefined;
    const state = {
      on: "is on",
      off: "is off",
      warn: "isn't confirmed",
      error: "is blocked",
    }[tone];
    await Promise.all([
      chrome.action.setIcon({
        path: tone === "off" ? TOOLBAR_ICONS.off : TOOLBAR_ICONS.on,
      }),
      chrome.action.setTitle({
        title: `Mullvad Proxy ${state}. ${detail}`.trim(),
      }),
      chrome.action.setBadgeText({
        text:
          tone === "on"
            ? (exit?.countryCode.toUpperCase() ?? "ON")
            : tone === "off"
              ? ""
              : "!",
      }),
      chrome.action.setBadgeBackgroundColor({
        color: tone === "on" ? "#44ad4d" : "#d98c00",
      }),
    ]);
  }
  private async dispatch(
    command: Exclude<Command, { type: "diagnostics.run" }>,
  ): Promise<unknown> {
    const context = command.context ?? "regular";
    if (context === "incognito" && !(await this.privateUsable()))
      throw new Failure(
        "blocked",
        "Allow the extension in Incognito and open an Incognito window first.",
      );
    const state =
      context === "incognito"
        ? (this.session.privateState ?? this.state)
        : this.state;
    const next = structuredClone(state);
    // Private records keep the settings shape; reload behavior always comes from regular settings.
    next.settings.preferences.autoReload =
      this.state.settings.preferences.autoReload;
    next.revision++;
    const routing = next.settings.routing;
    const checkServer = (id: string) => {
      if (
        id !== INTERNAL_DEFAULT_SERVER_ID &&
        !this.catalog().some((server) => server.id === id && server.online)
      )
        throw new Failure("invalid-input", "Choose a server that's online.");
    };
    // validateCommand has already canonicalized every host in the command.
    switch (command.type) {
      case "snapshot":
        return this.snapshot(context);
      case "settings.export":
        return {
          version: 1,
          settings: structuredClone(next.settings),
          history:
            context === "incognito" ? [] : structuredClone(state.history),
          favorites: structuredClone(this.state.favorites),
        };
      case "settings.import.preview":
      case "settings.import": {
        const preview = this.routingCore.validateImport(
          command.data,
          this.catalog(),
        );
        if (!preview.ok) throw new Failure("invalid-input", preview.error);
        if (
          context === "incognito" &&
          preview.value.preferences &&
          preview.value.preferences.autoReload !==
            this.state.settings.preferences.autoReload
        )
          throw new Failure(
            "blocked",
            "This file changes the reload setting. Change it in regular settings first.",
          );
        if (command.type === "settings.import.preview") return preview.value;
        next.settings.routing = { ...routing, ...preview.value.routing };
        if (preview.value.preferences)
          next.settings.preferences = preview.value.preferences;
        if (preview.value.history && context === "regular")
          next.history = preview.value.history;
        if (preview.value.favorites && context === "regular")
          next.favorites = preview.value.favorites;
        break;
      }
      case "settings.update": {
        const { enabled, randomMode, autoReload, historyEnabled } =
          command.patch;
        if (enabled !== undefined) {
          routing.enabled = enabled;
          if (enabled && routing.globalServerId === null)
            routing.globalServerId = INTERNAL_DEFAULT_SERVER_ID;
        }
        if (randomMode !== undefined) routing.randomMode = randomMode;
        if (autoReload !== undefined) {
          if (
            context === "incognito" &&
            autoReload !== this.state.settings.preferences.autoReload
          )
            throw new Failure(
              "blocked",
              "Change the reload setting in regular settings.",
            );
          next.settings.preferences.autoReload = autoReload;
        }
        if (historyEnabled !== undefined)
          next.settings.preferences.historyEnabled = historyEnabled;
        break;
      }
      case "server.select": {
        checkServer(command.serverId);
        const site = command.host;
        if (site) {
          routing.rules = routing.rules.filter((rule) => rule.host !== site);
          routing.rules.push({
            host: site,
            enabled: true,
            serverId: command.serverId,
          });
        } else {
          routing.globalServerId = command.serverId;
          routing.enabled = true;
        }
        if (context === "regular" && next.settings.preferences.historyEnabled) {
          const server = this.catalog().find(
            (row) => row.id === command.serverId,
          );
          if (server) {
            const entry = next.history.find(
              (row) => row.serverId === server.id,
            );
            if (entry) {
              entry.count++;
              entry.lastUsedAt = Date.now();
            } else
              next.history.push({
                serverId: server.id,
                hostname: server.hostname,
                country: server.country,
                countryCode: server.countryCode,
                city: server.city,
                count: 1,
                lastUsedAt: Date.now(),
              });
          }
        }
        break;
      }
      case "rule.upsert": {
        const { rule } = command;
        const existing = routing.rules.find((row) => row.host === rule.host);
        if (rule.enabled || !existing || existing.serverId !== rule.serverId)
          checkServer(rule.serverId);
        routing.rules = routing.rules.filter((row) => row.host !== rule.host);
        routing.rules.push(rule);
        break;
      }
      case "rule.remove":
        routing.rules = routing.rules.filter(
          (rule) => rule.host !== command.host,
        );
        break;
      case "exclusion.set":
        routing.exclusions = routing.exclusions.filter(
          (entry) => entry !== command.host,
        );
        if (command.excluded) routing.exclusions.push(command.host);
        break;
      case "history.clear":
        next.history = [];
        break;
      case "history.remove":
        next.history = next.history.filter(
          (entry) => entry.serverId !== command.serverId,
        );
        break;
      case "favorite.set": {
        // A first private save creates a session routing override; a star must not.
        if (context === "incognito")
          throw new Failure("blocked", "Change favorites in a regular window.");
        const id = command.serverId;
        if (
          command.favorite &&
          !this.catalog().some((server) => server.id === id)
        )
          throw new Failure("invalid-input", "Choose a server from the list.");
        next.favorites = next.favorites.filter((entry) => entry !== id);
        if (command.favorite) next.favorites.push(id);
        break;
      }
      case "servers.refresh": {
        if (context === "incognito")
          throw new Failure(
            "blocked",
            "Refresh the server list from a regular window.",
          );
        const updatedAt = Date.now();
        let value: Server[];
        try {
          const result = this.routingCore.validateServers(
            await requestJson(
              "https://api.mullvad.net/network/v1-beta1/socks-proxies",
            ),
          );
          if (!result.ok) throw new Error(result.error);
          value = result.value;
          await write(chrome.storage.local, CACHE, { value, updatedAt });
        } catch {
          throw new Failure(
            "offline",
            "Couldn't load the server list. Your routing hasn't changed.",
          );
        }
        this.servers = { status: "ready", value, updatedAt };
        // Freeze the random pool for this browser session, including worker restarts.
        if (!this.session.pool.length) {
          this.session.pool = value;
          await this.saveSession();
        }
        await this.reconcileAll();
        return this.snapshot(context);
      }
      case "privacy.set":
      case "privacy.restore": {
        if (context === "incognito")
          throw new Failure(
            "blocked",
            "Change privacy settings from a regular window.",
          );
        if (!(await this.permission("privacy")))
          throw new Failure(
            "permission-denied",
            "Allow the privacy permission first.",
          );
        const setting =
          command.control === "webRtcNonProxiedUdp"
            ? chrome.privacy.network.webRTCIPHandlingPolicy
            : chrome.privacy.network.networkPredictionEnabled;
        const details = await setting.get({});
        if (command.type === "privacy.restore") {
          if (details.levelOfControl === "controlled_by_this_extension")
            await setting.clear({ scope: "regular" });
        } else {
          if (
            ![
              "controllable_by_this_extension",
              "controlled_by_this_extension",
            ].includes(details.levelOfControl)
          )
            throw new Failure(
              "blocked",
              "Another extension or a Chrome policy controls this setting.",
            );
          if (command.control === "webRtcNonProxiedUdp")
            await chrome.privacy.network.webRTCIPHandlingPolicy.set({
              value: command.enabled ? "disable_non_proxied_udp" : "default",
              scope: "regular",
            });
          else
            await chrome.privacy.network.networkPredictionEnabled.set({
              value: command.enabled,
              scope: "regular",
            });
        }
        return this.snapshot(context);
      }
    }
    // An empty frozen pool would make the mandatory PAC block every website.
    if (
      next.settings.routing.randomMode &&
      !state.settings.routing.randomMode &&
      !this.session.pool.some((server) => server.online)
    )
      throw new Failure(
        "blocked",
        "Load the server list before turning on random mode.",
      );
    const routingChanged =
      JSON.stringify(next.settings.routing) !==
      JSON.stringify(state.settings.routing);
    await this.save(next, context, routingChanged);
    // Reload is intentionally UI-owned: the worker has no trusted active-tab target.
    return this.snapshot(context);
  }
  private failure(error: unknown): Response<never> {
    return {
      ok: false,
      error: {
        code: error instanceof Failure ? error.code : "internal",
        message:
          error instanceof Failure
            ? error.message
            : "Something went wrong. Try again.",
      },
    };
  }
  private async diagnose(
    command: Extract<Command, { type: "diagnostics.run" }>,
  ): Promise<Response<unknown>> {
    try {
      const context = command.context ?? "regular";
      if (context === "incognito")
        throw new Failure(
          "blocked",
          "Checks only run in regular windows. Open mullvad.net/check in an Incognito tab instead.",
        );
      const diagnostics = await runDiagnostics(command.checks);
      return {
        ok: true,
        value: await this.queued(() => this.snapshot(context, diagnostics)),
      };
    } catch (error) {
      return this.failure(error);
    }
  }
  execute(
    input: unknown,
    sender?: chrome.runtime.MessageSender,
  ): Promise<Response<unknown>> {
    return this.queued(async () => {
      try {
        const validation = this.routingCore.validateCommand(input);
        if (!validation.ok)
          throw new Failure("invalid-input", validation.error);
        if (
          sender &&
          !trustedSender(sender, validation.value.context ?? "regular")
        )
          throw new Failure(
            "permission-denied",
            "Only this extension's popup/options can issue commands.",
          );
        if (sender && !sender.tab) {
          const window = await chrome.windows.getLastFocused({});
          if (
            Boolean(window.incognito) !==
            (validation.value.context === "incognito")
          )
            throw new Failure(
              "permission-denied",
              "Command context does not match the active extension window.",
            );
        }
        await this.initialize();
        const command = validation.value;
        // Connection checks wait seconds on the network; holding the queue would stall routing changes.
        if (command.type === "diagnostics.run") return command;
        return { ok: true as const, value: await this.dispatch(command) };
      } catch (error) {
        return this.failure(error);
      }
    }).then((result) => ("type" in result ? this.diagnose(result) : result));
  }
  client<C extends Command>(command: C): Promise<Response<CommandResult<C>>> {
    // execute validates both UI and development commands before using the typed contract.
    return this.execute(command) as Promise<Response<CommandResult<C>>>;
  }
  privateWindowCreated(window: chrome.windows.Window): void {
    if (!window.incognito || window.id === undefined) return;
    this.privateWindows.add(window.id);
    this.enqueue(() => this.savePrivateWindows());
  }
  privateWindowChanged(windowId?: number): void {
    const removedPrivate =
      windowId !== undefined && this.privateWindows.delete(windowId);
    const ended = removedPrivate && this.privateWindows.size === 0;
    if (ended) this.privateEpoch++;
    // Permission events may concern unrelated permissions, not Incognito opt-in.
    const permission =
      windowId === undefined
        ? this.allowed().then((allowed) => {
            if (!allowed) this.privateEpoch++;
            return allowed;
          })
        : Promise.resolve(true);
    this.enqueue(async () => {
      const permitted = await permission;
      if (!ended && permitted && (await this.privateUsable()))
        return this.savePrivateWindows();
      await this.endPrivate();
      // Chrome expires the private PAC at last-window close; also remove a stale
      // in-flight override if a new private session opened before this queue ran.
      if ((ended || !permitted) && (await this.privateUsable()))
        await this.clearPrivateOverride();
    });
  }
  refresh(): void {
    this.enqueue(async () => {
      await this.initialize();
      await this.reconcileAll();
      await this.snapshot("regular");
    });
  }
}
export const controller = new Controller();
