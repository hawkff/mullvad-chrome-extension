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
import { emptyDiagnostics, runDiagnostics } from "./diagnostics";
import { callback, object, requestJson, voidCallback } from "./platform";
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
function ownership(input: unknown): ProxyOwnership {
  return input === "not_controllable" ||
    input === "controlled_by_other_extensions" ||
    input === "controllable_by_this_extension" ||
    input === "controlled_by_this_extension"
    ? input
    : "unknown";
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
      | "canonicalHost"
      | "generatePac"
      | "validateCommand"
      | "validateImport"
      | "validateServers"
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
  private async allowed(): Promise<boolean> {
    return callback<boolean>((done) =>
      chrome.extension.isAllowedIncognitoAccess(done),
    );
  }
  private async privateOpen(): Promise<boolean> {
    return (
      await callback<chrome.windows.Window[]>((done) =>
        chrome.windows.getAll({}, done),
      )
    ).some((window) => window.incognito);
  }
  private async permission(name: "proxy" | "privacy"): Promise<boolean> {
    return callback<boolean>((done) =>
      chrome.permissions.contains({ permissions: [name] }, done),
    );
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const cache = await read(chrome.storage.local, CACHE);
    if (cache !== undefined) {
      try {
        const pool = validPool(cache);
        this.servers = { status: "ready", value: pool, updatedAt: 0 };
      } catch {
        this.servers = {
          status: "error",
          message: "Invalid cached server list; refresh required.",
        };
      }
    }
    const windows = await callback<chrome.windows.Window[]>((done) =>
      chrome.windows.getAll({}, done),
    );
    this.privateWindows = new Set(
      windows
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
          "Invalid session routing pool; existing proxy was not changed. Restart the browser to recover.",
        );
      }
    } else this.session = { seed: crypto.randomUUID(), pool: this.catalog() };
    const saved = await read(chrome.storage.local, STATE);
    try {
      if (saved !== undefined)
        this.state = validateStored(
          saved,
          this.catalog(),
          this.routingCore.validateImport,
        );
    } catch {
      this.startupError = true;
      throw new Failure(
        "internal",
        "Saved settings failed validation; existing proxy and storage were left untouched.",
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
      this.session.privateSeed = rawSession.privateSeed as string;
      this.session.privateWindows = [...this.privateWindows];
      this.session.privateState = validateStored(
        rawSession.privateState,
        this.catalog(),
        this.routingCore.validateImport,
      );
    }
    await write(chrome.storage.session, SESSION, this.session);
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
    const permitted = await this.permission("proxy");
    const result: ProxyStatus = {
      scope: context,
      settingScope: "unknown",
      ownership: "unknown",
      permissionGranted: permitted,
      applied: false,
      status: "blocked",
    };
    if (!permitted) {
      result.message = "Proxy permission is not available.";
      return result;
    }
    if (context === "incognito" && !(await this.allowed())) {
      result.message = "Enable Allow in Incognito in Chrome extension details.";
      return result;
    }
    try {
      const details = await callback<
        chrome.types.ChromeSettingGetResult<unknown>
      >((done) =>
        chrome.proxy.settings.get({ incognito: context === "incognito" }, done),
      );
      result.ownership = ownership(details.levelOfControl);
      const expected =
        context === "incognito"
          ? (this.session.privateState ?? this.state)
          : this.state;
      const value: unknown = details.value;
      result.applied =
        result.ownership === "controlled_by_this_extension" &&
        this.active(expected) &&
        object(value) &&
        value.mode === "pac_script" &&
        object(value.pacScript) &&
        value.pacScript.data ===
          this.pac(
            expected,
            context === "incognito" && this.session.privateState
              ? "incognito"
              : "regular",
          ) &&
        value.pacScript.mandatory === true;
      if (
        context === "incognito" &&
        result.ownership === "controlled_by_this_extension" &&
        details.incognitoSpecific &&
        object(value) &&
        value.mode === "direct" &&
        this.session.privateState
      )
        result.settingScope = "incognito_session_only";
      if (result.applied)
        result.settingScope =
          context === "incognito" && details.incognitoSpecific
            ? "incognito_session_only"
            : "regular";
      result.status =
        result.ownership === "controlled_by_other_extensions" ||
        result.ownership === "not_controllable"
          ? "blocked"
          : "ready";
      if (result.status === "blocked")
        result.message =
          "Chrome policy or another extension controls this effective proxy setting.";
      else if (this.active(expected) && !result.applied) {
        result.status = "error";
        result.message =
          "Saved routes are not confirmed as the effective mandatory proxy.";
      }
    } catch {
      result.status = "error";
      result.message = "Chrome could not report the effective proxy setting.";
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
          current.message ?? "Proxy control unavailable",
        );
      return;
    }
    if (this.active(state)) {
      const existing = await callback<
        chrome.types.ChromeSettingGetResult<unknown>
      >((done) =>
        chrome.proxy.settings.get({ incognito: context === "incognito" }, done),
      );
      const existingValue = existing.value;
      if (
        existing.levelOfControl === "controlled_by_this_extension" &&
        object(existingValue) &&
        existingValue.mode === "pac_script" &&
        object(existingValue.pacScript) &&
        existingValue.pacScript.data === this.pac(state, context) &&
        existingValue.pacScript.mandatory === true
      )
        return;
      await voidCallback((done) =>
        chrome.proxy.settings.set(
          {
            value: {
              mode: "pac_script",
              pacScript: { data: this.pac(state, context), mandatory: true },
            },
            scope: this.scope(context),
          },
          done,
        ),
      );
      const confirmation = await callback<
        chrome.types.ChromeSettingGetResult<unknown>
      >((done) =>
        chrome.proxy.settings.get({ incognito: context === "incognito" }, done),
      );
      const value: unknown = confirmation.value;
      if (
        confirmation.levelOfControl !== "controlled_by_this_extension" ||
        !object(value) ||
        value.mode !== "pac_script" ||
        !object(value.pacScript) ||
        value.pacScript.data !== this.pac(state, context) ||
        value.pacScript.mandatory !== true
      )
        throw new Failure(
          "blocked",
          "Chrome did not confirm the requested mandatory PAC.",
        );
    } else if (context === "incognito") {
      const existing = await callback<
        chrome.types.ChromeSettingGetResult<unknown>
      >((done) => chrome.proxy.settings.get({ incognito: true }, done));
      if (
        existing.levelOfControl === "controlled_by_this_extension" &&
        existing.incognitoSpecific &&
        object(existing.value) &&
        existing.value.mode === "direct"
      )
        return;
      await voidCallback((done) =>
        chrome.proxy.settings.set(
          { value: { mode: "direct" }, scope: "incognito_session_only" },
          done,
        ),
      );
      const confirmation = await callback<
        chrome.types.ChromeSettingGetResult<unknown>
      >((done) => chrome.proxy.settings.get({ incognito: true }, done));
      if (
        confirmation.levelOfControl !== "controlled_by_this_extension" ||
        !confirmation.incognitoSpecific ||
        !object(confirmation.value) ||
        confirmation.value.mode !== "direct"
      )
        throw new Failure(
          "blocked",
          "Chrome did not confirm the private-session direct override.",
        );
    } else if (current.ownership === "controlled_by_this_extension") {
      // An inherited regular setting must not be cleared from the private scope.
      await voidCallback((done) =>
        chrome.proxy.settings.clear({ scope: this.scope(context) }, done),
      );
    }
  }
  private async privacy(): Promise<PrivacyStatus> {
    const result: PrivacyStatus = {
      permissionGranted: await this.permission("privacy"),
      webRtc: { ownership: "unknown", value: null },
      networkPrediction: { ownership: "unknown", value: null },
    };
    if (!result.permissionGranted) return result;
    const rtc = await callback<chrome.types.ChromeSettingGetResult<unknown>>(
      (done) => chrome.privacy.network.webRTCIPHandlingPolicy.get({}, done),
    );
    const prediction = await callback<
      chrome.types.ChromeSettingGetResult<unknown>
    >((done) => chrome.privacy.network.networkPredictionEnabled.get({}, done));
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
    await Promise.all([
      voidCallback((done) =>
        chrome.action.setBadgeText(
          {
            text: proxy.applied
              ? "ON"
              : proxy.status === "blocked" || proxy.status === "error"
                ? "!"
                : "",
          },
          done,
        ),
      ),
      voidCallback((done) =>
        chrome.action.setBadgeBackgroundColor(
          { color: proxy.applied ? "#44ad4d" : "#d98c00" },
          done,
        ),
      ),
    ]);
    return {
      context,
      incognitoAllowed: await this.allowed(),
      revision: state.revision,
      settings: structuredClone(state.settings),
      history: context === "incognito" ? [] : structuredClone(state.history),
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
    if (
      context === "incognito" &&
      (!(await this.allowed()) || !(await this.privateOpen()))
    )
      throw new Failure("blocked", "No opted-in private window is open.");
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
          throw new Failure("blocked", "Private session closed during update.");
        const session = {
          ...this.session,
          privateState: { ...next, history: [] },
        };
        await write(chrome.storage.session, SESSION, session);
        this.session = session;
        if (
          epoch !== this.privateEpoch ||
          !(await this.privateOpen()) ||
          !(await this.allowed())
        ) {
          delete this.session.privateState;
          delete this.session.privateSeed;
          delete this.session.privateWindows;
          await write(chrome.storage.session, SESSION, this.session);
          throw new Failure(
            "blocked",
            "Private session ended during storage update.",
          );
        }
      }
    } catch (error) {
      if (
        routing &&
        (context === "regular" ||
          (epoch === this.privateEpoch &&
            (await this.privateOpen()) &&
            (await this.allowed())))
      )
        if (context === "incognito" && !hadPrivateState) {
          const current = await callback<
            chrome.types.ChromeSettingGetResult<unknown>
          >((done) => chrome.proxy.settings.get({ incognito: true }, done));
          if (
            current.levelOfControl === "controlled_by_this_extension" &&
            current.incognitoSpecific
          )
            await voidCallback((done) =>
              chrome.proxy.settings.clear(
                { scope: "incognito_session_only" },
                done,
              ),
            );
          delete this.session.privateSeed;
          delete this.session.privateWindows;
        } else await this.reconcile(previous, context, false);
      throw error;
    }
  }
  private async dispatch(command: Command): Promise<unknown> {
    const context = command.context ?? "regular";
    if (
      context === "incognito" &&
      (!(await this.allowed()) || !(await this.privateOpen()))
    )
      throw new Failure(
        "blocked",
        "Incognito requires Chrome opt-in and an open private window.",
      );
    const state =
      context === "incognito"
        ? (this.session.privateState ?? this.state)
        : this.state;
    const next = structuredClone(state);
    next.revision++;
    const routing = next.settings.routing;
    const host = (input: string): string => {
      const result = this.routingCore.canonicalHost(input);
      if (!result.ok) throw new Failure("invalid-input", result.error);
      return result.value;
    };
    const checkServer = (id: string) => {
      if (
        id !== INTERNAL_DEFAULT_SERVER_ID &&
        !this.catalog().some((server) => server.id === id && server.online)
      )
        throw new Failure("invalid-input", "Select a known online server.");
    };
    switch (command.type) {
      case "snapshot":
        return this.snapshot(context);
      case "settings.export":
        return {
          version: 1,
          settings: structuredClone(state.settings),
          history:
            context === "incognito" ? [] : structuredClone(state.history),
        };
      case "settings.import.preview": {
        const preview = this.routingCore.validateImport(
          command.data,
          this.catalog(),
        );
        if (!preview.ok) throw new Failure("invalid-input", preview.error);
        return preview.value;
      }
      case "settings.import": {
        const preview = this.routingCore.validateImport(
          command.data,
          this.catalog(),
        );
        if (!preview.ok) throw new Failure("invalid-input", preview.error);
        next.settings.routing = { ...routing, ...preview.value.routing };
        if (preview.value.preferences)
          next.settings.preferences = preview.value.preferences;
        if (preview.value.history && context === "regular")
          next.history = preview.value.history;
        break;
      }
      case "settings.update": {
        const { enabled, randomMode, autoReload, historyEnabled } =
          command.patch;
        if (enabled !== undefined) routing.enabled = enabled;
        if (randomMode !== undefined) routing.randomMode = randomMode;
        if (autoReload !== undefined)
          next.settings.preferences.autoReload = autoReload;
        if (historyEnabled !== undefined)
          next.settings.preferences.historyEnabled = historyEnabled;
        break;
      }
      case "server.select": {
        checkServer(command.serverId);
        if (command.host) {
          const name = host(command.host);
          routing.rules = routing.rules.filter((rule) => rule.host !== name);
          routing.rules.push({
            host: name,
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
        checkServer(command.rule.serverId);
        const name = host(command.rule.host);
        routing.rules = routing.rules.filter((rule) => rule.host !== name);
        routing.rules.push({ ...command.rule, host: name });
        break;
      }
      case "rule.remove":
        routing.rules = routing.rules.filter(
          (rule) => rule.host !== host(command.host),
        );
        break;
      case "exclusion.set": {
        const name = host(command.host);
        routing.exclusions = routing.exclusions.filter(
          (entry) => entry !== name,
        );
        if (command.excluded) routing.exclusions.push(name);
        break;
      }
      case "history.clear":
        next.history = [];
        break;
      case "history.remove":
        next.history = next.history.filter(
          (entry) => entry.serverId !== command.serverId,
        );
        break;
      case "servers.refresh": {
        if (context === "incognito")
          throw new Failure(
            "blocked",
            "Refresh the shared public server catalog from a regular extension window.",
          );
        try {
          const result = this.routingCore.validateServers(
            await requestJson(
              "https://api.mullvad.net/network/v1-beta1/socks-proxies",
            ),
          );
          if (!result.ok)
            throw new Failure(
              "offline",
              "Mullvad returned an invalid server catalog.",
            );
          await write(chrome.storage.local, CACHE, result.value);
          this.servers = {
            status: "ready",
            value: result.value,
            updatedAt: Date.now(),
          };
          // Freeze the random pool for this browser session, including worker restarts.
          if (!this.session.pool.length) {
            this.session.pool = result.value;
            await write(chrome.storage.session, SESSION, this.session);
          }
          await this.reconcile(this.state, "regular", false);
          return this.snapshot(context);
        } catch {
          throw new Failure(
            "offline",
            "Server refresh failed or timed out; cached routing remains in place.",
          );
        }
      }
      case "diagnostics.run": {
        if (context === "incognito")
          throw new Failure(
            "blocked",
            "A spanning service worker cannot guarantee private-context diagnostic requests. Open the official Mullvad check in a private tab instead.",
          );
        return this.snapshot(context, await runDiagnostics(command.checks));
      }
      case "privacy.set":
      case "privacy.restore": {
        if (context === "incognito")
          throw new Failure(
            "blocked",
            "Privacy overrides are browser-wide. Change them from a regular extension page.",
          );
        if (!(await this.permission("privacy")))
          throw new Failure(
            "permission-denied",
            "Grant privacy permission from the extension page first.",
          );
        const setting =
          command.control === "webRtcNonProxiedUdp"
            ? chrome.privacy.network.webRTCIPHandlingPolicy
            : chrome.privacy.network.networkPredictionEnabled;
        const details = await callback<
          chrome.types.ChromeSettingGetResult<unknown>
        >((done) => setting.get({}, done));
        if (command.type === "privacy.restore") {
          if (details.levelOfControl === "controlled_by_this_extension")
            await voidCallback((done) =>
              setting.clear({ scope: "regular" }, done),
            );
        } else {
          if (
            ![
              "controllable_by_this_extension",
              "controlled_by_this_extension",
            ].includes(details.levelOfControl)
          )
            throw new Failure(
              "blocked",
              "Another extension or policy controls this privacy setting.",
            );
          if (command.control === "webRtcNonProxiedUdp") {
            await voidCallback((done) =>
              chrome.privacy.network.webRTCIPHandlingPolicy.set(
                {
                  value: command.enabled
                    ? "disable_non_proxied_udp"
                    : "default",
                  scope: "regular",
                },
                done,
              ),
            );
          } else
            await voidCallback((done) =>
              chrome.privacy.network.networkPredictionEnabled.set(
                { value: command.enabled, scope: "regular" },
                done,
              ),
            );
        }
        return this.snapshot(context);
      }
    }
    const routingChanged =
      JSON.stringify(next.settings.routing) !==
      JSON.stringify(state.settings.routing);
    await this.save(next, context, routingChanged);
    // Reload is intentionally UI-owned: the worker has no trusted active-tab target.
    return this.snapshot(context);
  }
  execute(
    input: unknown,
    sender?: chrome.runtime.MessageSender,
  ): Promise<Response<unknown>> {
    const task = this.tail.then(async (): Promise<Response<unknown>> => {
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
          const window = await callback<chrome.windows.Window>((done) =>
            chrome.windows.getLastFocused({}, done),
          );
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
        return { ok: true, value: await this.dispatch(validation.value) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof Failure ? error.code : "internal",
            message:
              error instanceof Failure
                ? error.message
                : "Operation failed. Existing proxy settings were not deliberately disabled; inspect Chrome ownership and retry.",
          },
        };
      }
    });
    this.tail = task;
    return task;
  }
  client<C extends Command>(command: C): Promise<Response<CommandResult<C>>> {
    // execute validates both UI and development commands before using the typed contract.
    return this.execute(command) as Promise<Response<CommandResult<C>>>;
  }
  privateWindowCreated(window: chrome.windows.Window): void {
    if (!window.incognito || window.id === undefined) return;
    this.privateWindows.add(window.id);
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        if (this.session.privateState) {
          this.session.privateWindows = [...this.privateWindows];
          await write(chrome.storage.session, SESSION, this.session);
        }
      })
      .catch(() => undefined);
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
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        const permitted = await permission;
        if (
          !ended &&
          permitted &&
          (await this.allowed()) &&
          (await this.privateOpen())
        ) {
          if (this.session.privateState) {
            this.session.privateWindows = [...this.privateWindows];
            await write(chrome.storage.session, SESSION, this.session);
          }
          return;
        }
        delete this.session.privateState;
        delete this.session.privateSeed;
        delete this.session.privateWindows;
        if (this.initialized)
          await write(chrome.storage.session, SESSION, this.session);
        // Chrome expires the private PAC at last-window close; also remove a stale
        // in-flight override if a new private session opened before this queue ran.
        if (
          (ended || !permitted) &&
          (await this.allowed()) &&
          (await this.privateOpen())
        ) {
          const setting = await callback<
            chrome.types.ChromeSettingGetResult<unknown>
          >((done) => chrome.proxy.settings.get({ incognito: true }, done));
          if (
            setting.levelOfControl === "controlled_by_this_extension" &&
            setting.incognitoSpecific
          )
            await voidCallback((done) =>
              chrome.proxy.settings.clear(
                { scope: "incognito_session_only" },
                done,
              ),
            );
        }
      })
      .catch(() => undefined);
  }
  refresh(): void {
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        await this.initialize();
        if (!(await this.allowed()) || !(await this.privateOpen())) {
          delete this.session.privateState;
          delete this.session.privateSeed;
          delete this.session.privateWindows;
          await write(chrome.storage.session, SESSION, this.session);
        }
        await this.reconcile(this.state, "regular", false);
        if (this.session.privateState)
          await this.reconcile(this.session.privateState, "incognito", false);
        await this.snapshot("regular");
      })
      .catch(() => undefined);
  }
}
export const controller = new Controller();
