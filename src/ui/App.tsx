import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../core/engine";
import { checked, relayName, host as validateHost } from "../core/validation";
import type { Command, CommandResult } from "../shared/messages";
import {
  type BrowserContext,
  type Diagnostics,
  type ImportPreview,
  INTERNAL_DEFAULT_SERVER_ID,
  type Server,
  type Snapshot,
} from "../shared/state";
import { plural, proxyStatus, type Tone } from "../shared/status";
import {
  checkStatus,
  checksCoverSite,
  client,
  currentWebsiteTab,
  exitStatus,
  freshness,
  incognitoScopeDescription,
  STALE_AFTER,
  searchServers,
} from "./client";

const isOptions = location.pathname.endsWith("options.html");
const icons: Record<Tone, string> = {
  on: "M5 12.5l4.5 4.5L19 7.5",
  off: "M7 12h10",
  warn: "M12 6.5v7M12 17.5v.01",
  error: "M7 7l10 10M17 7L7 17",
};

function Mark({ tone }: { tone: Tone }) {
  return (
    <svg
      className="mark"
      data-tone={tone}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d={icons[tone]} />
    </svg>
  );
}

const unchecked = (status: "unknown" | "pending"): Diagnostics => ({
  scope: "browser-route",
  ipv4: { status },
  ipv6: { status },
  dns: { status },
});
async function loadChecks(context: BrowserContext): Promise<Diagnostics> {
  try {
    const response = await client({
      type: "diagnostics.run",
      checks: ["ipv4", "ipv6", "dns"],
      context,
    });
    if (response.ok) return response.value.diagnostics;
    throw new Error(response.error.message);
  } catch (e) {
    const failed = {
      status: "error" as const,
      message: e instanceof Error ? e.message : "The checks failed.",
    };
    return { scope: "browser-route", ipv4: failed, ipv6: failed, dns: failed };
  }
}
// Extension pages may open chrome:// pages; websites cannot.
const openTab = async (url: string) =>
  chrome.tabs.create({
    url,
    windowId: (await chrome.windows.getCurrent({})).id,
  });

function RelayRow({
  server,
  current,
  favorite,
  place = false,
  missing = false,
  busy,
  onSelect,
  onFavorite,
}: {
  server: Server;
  current: boolean;
  favorite: boolean;
  place?: boolean;
  missing?: boolean;
  busy: boolean;
  onSelect: () => void;
  onFavorite?: () => void;
}) {
  const name = relayName(server.hostname);
  return (
    <div className="relay-row">
      <button
        type="button"
        className={place ? "select place" : "select"}
        disabled={busy || !server.online}
        aria-current={current || undefined}
        onClick={onSelect}
      >
        <span className="relay">
          {place ? (
            <>
              {missing
                ? "No longer listed"
                : `${server.city}, ${server.country}`}
              <small>{name}</small>
            </>
          ) : (
            <>
              <span className="sr-only">{server.city}, </span>
              {name}
            </>
          )}
        </span>
        <span className="state">
          {current ? (
            <>
              <Mark tone="on" /> In use
            </>
          ) : missing ? (
            "Unavailable"
          ) : server.online ? null : (
            "Offline"
          )}
        </span>
      </button>
      {onFavorite ? (
        <button
          type="button"
          className="star"
          disabled={busy}
          aria-pressed={favorite}
          aria-label={
            favorite
              ? `Remove ${name} from favorites`
              : `Add ${name} to favorites`
          }
          onClick={onFavorite}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

export function App({ context }: { context: BrowserContext }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [host, setHost] = useState("");
  const [target, setTarget] = useState<"global" | "site">("global");
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (picker) searchInput.current?.focus();
  }, [picker]);
  const errorBox = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // Popup content scrolls; keep a new error in view of the control that caused it.
    if (error) errorBox.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [section, setSection] = useState("routing");
  const [checks, setChecks] = useState(() => unchecked("unknown"));
  const checkRun = useRef(0);
  const runChecks = useCallback(() => {
    const run = ++checkRun.current;
    setChecks(unchecked("pending"));
    void loadChecks(context).then((result) => {
      // Results from a run started before a newer route change are stale.
      if (run === checkRun.current) setChecks(result);
    });
  }, [context]);
  // Loads state without disabling controls or announcing it.
  const load = useCallback(
    () =>
      client({ type: "snapshot", context }).then(
        (response) =>
          response.ok
            ? setSnapshot(response.value)
            : setError(response.error.message),
        (e: unknown) =>
          setError(
            e instanceof Error ? e.message : "Can't reach the extension.",
          ),
      ),
    [context],
  );

  async function request<C extends Command>(
    command: C,
  ): Promise<CommandResult<C> | undefined> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await client({ ...command, context });
      if (!response.ok) throw new Error(response.error.message);
      return response.value;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function mutate(
    command: Exclude<
      Command,
      {
        type: "settings.export" | "settings.import.preview" | "diagnostics.run";
      }
    >,
    routingChange = false,
  ) {
    const value = await request(command);
    if (value) {
      setSnapshot(value);
      setNotice(
        command.type === "snapshot"
          ? "Status refreshed."
          : command.type === "servers.refresh"
            ? "Server list updated."
            : command.type === "favorite.set"
              ? "Favorites updated."
              : "Settings updated.",
      );
      if (routingChange && !isOptions) {
        // Confirm that traffic gets through the new route.
        if (context === "regular") runChecks();
        if (value.settings.preferences.autoReload) {
          try {
            const tab = await currentWebsiteTab(context);
            await chrome.tabs.reload(tab.id);
          } catch (error) {
            setError(
              `Saved, but the website wasn't reloaded. ${error instanceof Error ? error.message : "Reload it yourself."}`,
            );
          }
        }
      }
    }
    return value;
  }
  useEffect(() => {
    void load();
    // Settings can change in another tab or window; reload when this page comes back.
    const refocus = () => void load();
    const reshow = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", refocus);
    document.addEventListener("visibilitychange", reshow);
    return () => {
      window.removeEventListener("focus", refocus);
      document.removeEventListener("visibilitychange", reshow);
    };
  }, [load]);
  useEffect(() => {
    if (isOptions) return;
    // Like upstream, the popup checks the connection as soon as it opens.
    if (context === "regular") runChecks();
    // Pages without an activeTab grant, such as chrome:// pages, have no current website.
    currentWebsiteTab(context).then(
      (tab) =>
        setHost(new URL(tab.url).hostname.toLowerCase().replace(/\.$/, "")),
      () => undefined,
    );
  }, [context, runChecks]);

  function openPicker(next: "global" | "site") {
    setTarget(next);
    setPicker(true);
    const list = snapshot?.servers;
    // Like upstream, load the relay list when the picker opens without a current copy.
    if (
      list &&
      (list.status !== "ready" || Date.now() - list.updatedAt > STALE_AFTER)
    )
      void mutate({ type: "servers.refresh" });
  }
  async function setRandom(enabled: boolean) {
    // The worker refuses random mode until a relay list has loaded.
    if (
      enabled &&
      snapshot?.servers.status !== "ready" &&
      !(await mutate({ type: "servers.refresh" }))
    )
      return;
    await mutate(
      { type: "settings.update", patch: { randomMode: enabled } },
      true,
    );
  }
  async function privacy(
    control: "webRtcNonProxiedUdp" | "networkPrediction",
    enabled?: boolean,
  ) {
    setError("");
    try {
      if (!(await chrome.permissions.request({ permissions: ["privacy"] })))
        throw new Error(
          "Chrome didn't grant the privacy permission. Nothing changed.",
        );
      await mutate(
        enabled === undefined
          ? { type: "privacy.restore", control }
          : { type: "privacy.set", control, enabled },
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Couldn't change the privacy setting.",
      );
    }
  }
  async function select(serverId: string) {
    if (target === "site" && !host) {
      setError("Open a website first.");
      return;
    }
    if (
      await mutate(
        {
          type: "server.select",
          serverId,
          ...(target === "site" ? { host } : {}),
        },
        true,
      )
    )
      setPicker(false);
  }
  async function exportSettings() {
    const value = await request({ type: "settings.export" });
    if (!value) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "mullvad-proxy-settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function previewImport() {
    setPreview(null);
    try {
      const value = await request({
        type: "settings.import.preview",
        data: JSON.parse(importText),
      });
      if (value) setPreview(value);
    } catch {
      setError(
        "This isn't valid JSON. Choose a backup from this extension or a Firefox export.",
      );
    }
  }
  const routing = snapshot?.settings.routing;
  const effective =
    context === "incognito" ? snapshot?.incognitoProxy : snapshot?.proxy;
  const servers =
    snapshot?.servers.status === "ready" ? snapshot.servers.value : [];
  const serverLabel = (id: string) => {
    if (id === INTERNAL_DEFAULT_SERVER_ID) return "Your VPN server";
    const server = servers.find((row) => row.id === id);
    return server
      ? `${server.city}, ${server.country} · ${relayName(server.hostname)}${server.online ? "" : " · Offline"}`
      : `Unavailable server: ${id}`;
  };
  const canonical = checked(() => validateHost(host));
  // The worker validates hosts the same way, so typed input fails here first.
  const fieldError = host && !canonical.ok ? canonical.error : "";
  const siteRule = canonical.ok
    ? routing?.rules.find((r) => r.host === canonical.value)
    : undefined;
  const excluded =
    canonical.ok && (routing?.exclusions.includes(canonical.value) ?? false);
  const matches = picker ? searchServers(servers, query) : [];
  const current =
    target === "site" ? siteRule?.serverId : routing?.globalServerId;
  const status =
    routing && effective ? proxyStatus(effective, routing, servers) : undefined;
  const checkRows = [
    ["IPv4", checks.ipv4],
    ["IPv6", checks.ipv6],
    ["DNS", checks.dns],
  ] as const;
  const checking = checks.ipv4.status === "pending";
  const exits = [checks.ipv4, checks.ipv6].filter(
    (state) => state.status === "ready",
  );
  // A failed IPv4 check means little when IPv6 got through.
  const checkFailed =
    !exits.length &&
    ["error", "offline", "blocked"].includes(checks.ipv4.status);
  // The check request follows the global route, so it tests the proxy only when that route is on.
  const routeWarning = exits.some((state) => !state.value.isMullvad)
    ? "Mullvad VPN isn't connected. Mullvad proxies only work through it."
    : !checkFailed
      ? ""
      : routing?.enabled || routing?.randomMode
        ? "The check couldn't get through the proxy. If websites don't load, connect Mullvad VPN or turn the proxy off."
        : "The connection check failed. Make sure you're online and Mullvad VPN is connected.";
  const siteRoute = (() => {
    if (!routing || !canonical.ok) return "";
    // The same engine builds the PAC, so this matches what the browser does.
    // Local addresses bypass the proxy before random mode applies.
    const route = engine.route(canonical.value, {
      settings: routing,
      servers,
      sessionSeed: "preview",
    });
    if (route.kind === "direct" && route.reason === "local")
      return "Local address. It always connects directly.";
    if (routing.randomMode)
      return "Gets a random location until Chrome restarts.";
    if (route.kind === "blocked")
      return snapshot?.servers.status === "ready"
        ? "Blocked until you choose an available location."
        : "Load the server list to see where this website goes.";
    if (route.kind === "direct")
      return route.reason === "excluded"
        ? "Excluded. It connects directly."
        : "Connects directly. Choose a location to proxy only this website.";
    const server = servers.find((row) => row.id === route.serverId);
    const where = server
      ? `${server.city}, ${server.country}`
      : "your VPN server";
    return route.source === "exact"
      ? `Uses its own location: ${where}.`
      : route.source === "parent"
        ? `Uses its parent domain's location: ${where}.`
        : `Follows the global location: ${where}.`;
  })();
  const favorites = snapshot?.favorites ?? [];
  // Favorites are shared with regular windows, so private popups show them read-only.
  const toggleFavorite = (server: Server) =>
    context === "regular"
      ? () =>
          mutate({
            type: "favorite.set",
            serverId: server.id,
            favorite: !favorites.includes(server.id),
          })
      : undefined;
  // Retired relays stay listed so their stars can still be removed.
  const missingServer = (id: string): Server => ({
    id,
    hostname: id,
    ipv4: "",
    ipv6: "",
    port: 0,
    online: false,
    country: "",
    countryCode: "",
    city: "",
  });
  const quickGroups = query.trim()
    ? []
    : [
        {
          label: "Favorites",
          rows: favorites.map(
            (id) =>
              servers.find((server) => server.id === id) ?? missingServer(id),
          ),
        },
        {
          label: "Recent",
          rows: (snapshot?.history ?? [])
            .slice()
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .flatMap((entry) =>
              servers.filter(
                (server) =>
                  server.id === entry.serverId &&
                  !favorites.includes(server.id),
              ),
            )
            .slice(0, 3),
        },
      ].filter((group) => group.rows.length);

  const locationPicker =
    snapshot && picker ? (
      <section className="card" aria-labelledby="picker-title">
        <div className="card-head">
          <h2 id="picker-title">
            {target === "site" ? "Site location" : "Global location"}
          </h2>
          <button
            type="button"
            className="ghost"
            onClick={() => setPicker(false)}
          >
            Close
          </button>
        </div>
        {target === "site" ? (
          <p className="meta">
            For <strong>{canonical.ok ? canonical.value : host}</strong>
          </p>
        ) : null}
        <label htmlFor="server-search">Search country, city or server</label>
        <input
          id="server-search"
          ref={searchInput}
          type="search"
          placeholder="Sweden, Gothenburg or se-got-001"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="meta-row">
          <p className="meta">{freshness(snapshot.servers)}</p>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => mutate({ type: "servers.refresh" })}
          >
            Refresh server list
          </button>
        </div>
        <ul className="server-list">
          {quickGroups.map((group) =>
            group.rows.map((server, index) => (
              <li key={`${group.label}-${server.id}`}>
                {index === 0 ? (
                  <h3 className="country">{group.label}</h3>
                ) : null}
                <RelayRow
                  server={server}
                  place
                  missing={!servers.some((row) => row.id === server.id)}
                  current={server.id === current}
                  favorite={favorites.includes(server.id)}
                  busy={busy}
                  onSelect={() => select(server.id)}
                  onFavorite={toggleFavorite(server)}
                />
              </li>
            )),
          )}
          {matches.map((server, index) => {
            const previous = matches[index - 1];
            const country = server.country !== previous?.country;
            return (
              <li key={server.id}>
                {country ? <h3 className="country">{server.country}</h3> : null}
                {country || server.city !== previous?.city ? (
                  <h4 className="city">{server.city}</h4>
                ) : null}
                <RelayRow
                  server={server}
                  current={server.id === current}
                  favorite={favorites.includes(server.id)}
                  busy={busy}
                  onSelect={() => select(server.id)}
                  onFavorite={toggleFavorite(server)}
                />
              </li>
            );
          })}
        </ul>
        {matches.length === 0 ? (
          <p>No servers match. Change your search or refresh the list.</p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => select(INTERNAL_DEFAULT_SERVER_ID)}
        >
          Use your VPN server
        </button>
      </section>
    ) : null;

  // The popup fills these from the current tab; the options page from typed input.
  const siteActions = host ? (
    <div className="actions">
      <button
        type="button"
        disabled={!canonical.ok}
        onClick={() => openPicker("site")}
      >
        Choose site location
      </button>
      <button
        type="button"
        disabled={!canonical.ok}
        onClick={() =>
          mutate({ type: "exclusion.set", host, excluded: !excluded }, true)
        }
      >
        {excluded ? "Remove exclusion" : "Add exclusion"}
      </button>
      {siteRule ? (
        <button
          type="button"
          className="danger"
          onClick={() => mutate({ type: "rule.remove", host }, true)}
        >
          Reset site rule
        </button>
      ) : null}
    </div>
  ) : null;

  const settingsButton = isOptions ? null : (
    <button
      type="button"
      className="ghost"
      title={
        context === "incognito"
          ? "Opens the settings for regular windows"
          : undefined
      }
      onClick={() => chrome.runtime.openOptionsPage()}
    >
      {context === "incognito" ? "Regular settings" : "Settings"}
    </button>
  );
  const privacyControls = snapshot
    ? ([
        {
          control: "webRtcNonProxiedUdp",
          label: "Stop WebRTC from bypassing the proxy",
          hint: "WebRTC can then only connect through the proxy. Some calls may stop working.",
          state: snapshot.privacy.webRtc,
          on: snapshot.privacy.webRtc.value === "disable_non_proxied_udp",
          enable: true,
        },
        {
          control: "networkPrediction",
          label: "Turn off network prediction",
          hint: "Stops Chrome from connecting to links before you click them.",
          state: snapshot.privacy.networkPrediction,
          on: snapshot.privacy.networkPrediction.value === false,
          enable: false,
        },
      ] as const)
    : [];

  return (
    <div className={isOptions ? "app options" : "app popup"}>
      <header>
        <div className="brand">
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9" />
          </svg>
          <h1>Mullvad Proxy</h1>
        </div>
        {context === "regular" ? settingsButton : null}
        {!isOptions && status ? (
          <ul className="pills" aria-label="Status summary">
            {(
              [
                ["Proxy", status.tone, `${status.title}. ${status.detail}`],
                ["VPN", ...exitStatus(checks)],
                ["DNS", ...checkStatus(checks.dns)],
              ] as const
            )
              // Checks never run in Incognito, so those pills would always read "not checked".
              .filter(([name]) => context === "regular" || name === "Proxy")
              .map(([name, tone, text]) => {
                // Connection checks observe browser requests, not the VPN tunnel itself.
                const label =
                  name === "Proxy" ? text : `Browser check: ${text}`;
                return (
                  <li key={name} className="pill" title={label}>
                    <Mark tone={tone} />
                    {name}
                    <span className="sr-only">: {label}</span>
                  </li>
                );
              })}
          </ul>
        ) : null}
      </header>
      <main>
        {context === "incognito" ? (
          <div className="context">
            <p>Incognito window</p>
            {settingsButton}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="error" ref={errorBox}>
            {error}
          </p>
        ) : null}
        <p className="feedback" role="status">
          {busy ? "Working…" : notice}
        </p>
        {!snapshot || !routing || !effective || !status ? (
          <section className="card" aria-busy={!error}>
            <h2>Connecting to the extension</h2>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // Focus reloads keep earlier errors; an explicit retry starts clean.
                setError("");
                void load();
              }}
            >
              Retry
            </button>
          </section>
        ) : !isOptions && picker ? (
          locationPicker
        ) : (
          <>
            {isOptions ? (
              <section className="card">
                <h2>Browser proxy</h2>
                <p className="status" data-tone={status.tone}>
                  <Mark tone={status.tone} />
                  <span>
                    <strong>{status.title}</strong> {status.detail}
                  </span>
                </p>
                {context === "incognito" ? (
                  <p className="hint">
                    {incognitoScopeDescription(snapshot.incognitoProxy)}
                  </p>
                ) : null}
              </section>
            ) : (
              <>
                {status.tone === "warn" || status.tone === "error" ? (
                  <p className="notice" data-tone={status.tone}>
                    <strong>{status.title}.</strong> {status.detail}
                  </p>
                ) : null}
                {routeWarning ? (
                  <p className="notice" data-tone="warn">
                    {routeWarning}
                  </p>
                ) : null}
                {context === "incognito" ? (
                  <p className="hint lead">
                    {incognitoScopeDescription(snapshot.incognitoProxy)}
                  </p>
                ) : null}
              </>
            )}
            {isOptions ? (
              <nav className="tabs" aria-label="Settings sections">
                {["routing", "privacy", "history", "backup"].map((name) => (
                  <button
                    type="button"
                    key={name}
                    aria-current={section === name ? "page" : undefined}
                    onClick={() => setSection(name)}
                  >
                    {name === "backup"
                      ? "Import / export"
                      : name[0]?.toUpperCase() + name.slice(1)}
                  </button>
                ))}
              </nav>
            ) : null}
            {!isOptions || section === "routing" ? (
              <>
                <section className="card">
                  <h2>Proxy routing</h2>
                  <fieldset disabled={busy}>
                    <div className="row">
                      <label className="switch">
                        <span>Proxy all websites</span>
                        <input
                          type="checkbox"
                          checked={routing.enabled}
                          onChange={(e) =>
                            mutate(
                              {
                                type: "settings.update",
                                patch: { enabled: e.target.checked },
                              },
                              true,
                            )
                          }
                        />
                      </label>
                      <p className="meta">
                        {routing.globalServerId
                          ? serverLabel(routing.globalServerId)
                          : "No location chosen"}
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          picker && target === "global"
                            ? setPicker(false)
                            : openPicker("global")
                        }
                      >
                        Change global location
                      </button>
                    </div>
                    {!isOptions ? (
                      <div className="row">
                        <h3>Current website</h3>
                        {host ? (
                          <>
                            <p className="hostname">{host}</p>
                            {siteRoute ? (
                              <p className="meta">{siteRoute}</p>
                            ) : null}
                            {siteActions}
                          </>
                        ) : (
                          <p className="hint">
                            Open a website to choose a location for it.
                          </p>
                        )}
                      </div>
                    ) : null}
                    <div className="row">
                      <label className="switch">
                        <span>Random mode</span>
                        <input
                          type="checkbox"
                          checked={routing.randomMode}
                          onChange={(e) => setRandom(e.target.checked)}
                        />
                      </label>
                      <p className="hint">
                        Gives each website a random location until Chrome
                        restarts. Overrides your other locations and exclusions.
                      </p>
                    </div>
                  </fieldset>
                </section>
                {isOptions ? locationPicker : null}
                {isOptions ? (
                  <section className="card">
                    <h2>Website rules</h2>
                    <fieldset disabled={busy}>
                      <label htmlFor="website-domain">Add a website</label>
                      <input
                        id="website-domain"
                        type="text"
                        placeholder="example.com"
                        autoCapitalize="none"
                        spellCheck={false}
                        aria-invalid={Boolean(fieldError) || undefined}
                        aria-describedby="website-domain-help"
                        value={host}
                        onChange={(event) => setHost(event.target.value)}
                      />
                      <p
                        id="website-domain-help"
                        className={fieldError ? "field-error" : "hint"}
                      >
                        {fieldError ||
                          "A rule for example.com also covers www.example.com."}
                      </p>
                      {siteRoute ? <p className="meta">{siteRoute}</p> : null}
                      {siteActions}
                      {routing.randomMode ? (
                        <p role="status" className="notice" data-tone="warn">
                          Random mode is on, so exclusions don't apply.
                        </p>
                      ) : null}
                      {routing.rules.length === 0 &&
                      routing.exclusions.length === 0 ? (
                        <p className="empty">No website rules yet.</p>
                      ) : null}
                      {routing.rules.map((rule) => (
                        <div className="rule" key={rule.host}>
                          <label className="switch">
                            <span>
                              {rule.host}
                              <small>{serverLabel(rule.serverId)}</small>
                            </span>
                            <input
                              type="checkbox"
                              checked={rule.enabled}
                              onChange={(e) =>
                                mutate(
                                  {
                                    type: "rule.upsert",
                                    rule: {
                                      ...rule,
                                      enabled: e.target.checked,
                                    },
                                  },
                                  true,
                                )
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              mutate(
                                { type: "rule.remove", host: rule.host },
                                true,
                              )
                            }
                          >
                            Remove rule
                          </button>
                        </div>
                      ))}
                      {routing.exclusions.map((item) => (
                        <div className="rule" key={item}>
                          <span>
                            {item}{" "}
                            <small>
                              {routing.randomMode
                                ? "Inactive while random mode is on"
                                : "Connects directly"}
                            </small>
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              mutate(
                                {
                                  type: "exclusion.set",
                                  host: item,
                                  excluded: false,
                                },
                                true,
                              )
                            }
                          >
                            Remove exclusion
                          </button>
                        </div>
                      ))}
                    </fieldset>
                  </section>
                ) : null}
              </>
            ) : null}
            {!isOptions ? (
              <section className="card" aria-labelledby="check-title">
                <div className="card-head">
                  <h2 id="check-title">Connection check</h2>
                  {context === "regular" ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={checking}
                      onClick={() => {
                        runChecks();
                        void load();
                      }}
                    >
                      Check again
                    </button>
                  ) : null}
                </div>
                {context === "incognito" ? (
                  <>
                    <p className="hint">
                      Checks only run in regular windows. Mullvad's own check
                      works in Incognito.
                    </p>
                    <button
                      type="button"
                      onClick={() => void openTab("https://mullvad.net/check")}
                    >
                      Open mullvad.net/check
                    </button>
                  </>
                ) : (
                  <>
                    {canonical.ok &&
                    !checksCoverSite(canonical.value, routing, servers) ? (
                      <p className="hint">
                        These results don't apply to {canonical.value}, which
                        takes a different route.
                      </p>
                    ) : null}
                    <ul className="checks">
                      {checkRows.map(([name, state]) => {
                        const [tone, text, detail] = checkStatus(state);
                        return (
                          <li key={name}>
                            <Mark tone={tone} />
                            <span className="check-name">{name}</span>
                            <span className="check-value">
                              {text}
                              {detail ? (
                                <small className="data">{detail}</small>
                              ) : null}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>
            ) : null}
            {isOptions && section === "routing" ? (
              <section className="card">
                <h2>Preferences</h2>
                <fieldset disabled={busy}>
                  <div className="row">
                    <label className="switch">
                      <span>
                        Reload the current website after routing changes in the
                        popup
                      </span>
                      <input
                        type="checkbox"
                        checked={snapshot.settings.preferences.autoReload}
                        onChange={(e) =>
                          mutate({
                            type: "settings.update",
                            patch: { autoReload: e.target.checked },
                          })
                        }
                      />
                    </label>
                  </div>
                  <div className="row">
                    <h3>Incognito</h3>
                    <p className="meta">
                      {snapshot.incognitoAllowed
                        ? "Allowed in Incognito."
                        : "Not allowed in Incognito. Turn on Allow in Incognito in the extension's details."}
                    </p>
                    <p className="hint">
                      Incognito windows use your regular routing until you
                      change it in one of them. Those changes last until you
                      close the last Incognito window.
                    </p>
                    {!snapshot.incognitoAllowed ? (
                      <button
                        type="button"
                        onClick={() =>
                          void openTab(
                            `chrome://extensions/?id=${chrome.runtime.id}`,
                          )
                        }
                      >
                        Open extension details
                      </button>
                    ) : null}
                  </div>
                </fieldset>
              </section>
            ) : null}
            {isOptions && section === "privacy" ? (
              <section className="card">
                <h2>Privacy</h2>
                <fieldset disabled={busy}>
                  {privacyControls.map((item) => {
                    const locked =
                      item.state.ownership ===
                        "controlled_by_other_extensions" ||
                      item.state.ownership === "not_controllable";
                    return (
                      <div className="row" key={item.control}>
                        <label className="switch">
                          <span>{item.label}</span>
                          <input
                            type="checkbox"
                            disabled={locked}
                            checked={
                              item.state.ownership ===
                                "controlled_by_this_extension" && item.on
                            }
                            onChange={(e) =>
                              privacy(
                                item.control,
                                e.target.checked ? item.enable : undefined,
                              )
                            }
                          />
                        </label>
                        <p className="hint">
                          {locked
                            ? "Another extension or a Chrome policy controls this setting."
                            : item.hint}
                        </p>
                      </div>
                    );
                  })}
                  <div className="row">
                    <h3>Secure DNS</h3>
                    <p className="hint">
                      Websites that connect directly look up addresses with
                      Chrome's DNS setting. Make sure Use secure DNS isn't set
                      to another provider.
                    </p>
                    <button
                      type="button"
                      onClick={() => void openTab("chrome://settings/security")}
                    >
                      Open DNS settings
                    </button>
                  </div>
                </fieldset>
              </section>
            ) : null}
            {isOptions && section === "history" ? (
              <section className="card">
                <h2>Location history</h2>
                <fieldset disabled={busy}>
                  <label className="switch">
                    <span>Remember the locations you use</span>
                    <input
                      type="checkbox"
                      checked={snapshot.settings.preferences.historyEnabled}
                      onChange={(e) =>
                        mutate({
                          type: "settings.update",
                          patch: { historyEnabled: e.target.checked },
                        })
                      }
                    />
                  </label>
                  <p className="hint">
                    Incognito windows don't add to history.
                  </p>
                  {snapshot.history.length === 0 ? (
                    <p className="empty">No locations yet.</p>
                  ) : (
                    <>
                      {snapshot.history.map((entry) => (
                        <div className="rule" key={entry.serverId}>
                          <span>
                            {entry.city}, {entry.country}
                            <small>
                              {relayName(entry.hostname)} · Used{" "}
                              {plural(entry.count, "time")} ·{" "}
                              {new Date(entry.lastUsedAt).toLocaleString()}
                            </small>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setQuery(relayName(entry.hostname));
                              setSection("routing");
                              openPicker("global");
                            }}
                          >
                            Use location
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              mutate({
                                type: "history.remove",
                                serverId: entry.serverId,
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          if (confirm("Clear your location history?"))
                            void mutate({ type: "history.clear" });
                        }}
                      >
                        Clear history
                      </button>
                    </>
                  )}
                </fieldset>
              </section>
            ) : null}
            {isOptions && section === "backup" ? (
              <section className="card">
                <h2>Import / export</h2>
                <p className="hint">
                  Import a backup from this extension or settings exported from
                  Mullvad's Firefox extension.
                </p>
                <button type="button" disabled={busy} onClick={exportSettings}>
                  Export settings
                </button>
                <label htmlFor="import-file">Choose settings file</label>
                <input
                  id="import-file"
                  type="file"
                  accept="application/json,.json"
                  disabled={busy}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    setPreview(null);
                    if (file) {
                      try {
                        if (file.size > 1000000)
                          throw new Error(
                            "Choose a settings file smaller than 1 MB.",
                          );
                        setImportText(await file.text());
                      } catch (err) {
                        setError(
                          err instanceof Error
                            ? err.message
                            : "Couldn't read this file.",
                        );
                      }
                    }
                  }}
                />
                <label htmlFor="import-json">Settings JSON</label>
                <textarea
                  id="import-json"
                  disabled={busy}
                  value={importText}
                  onChange={(e) => {
                    setImportText(e.target.value);
                    setPreview(null);
                  }}
                  rows={8}
                />
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !importText.trim()}
                  onClick={previewImport}
                >
                  Validate import
                </button>
                {preview ? (
                  <div className="preview">
                    <h3>
                      {preview.format === "firefox"
                        ? "Firefox settings"
                        : "Backup"}{" "}
                      ready to import
                    </h3>
                    <p>
                      Replaces your routes with{" "}
                      {plural(preview.routing.rules.length, "rule")} and{" "}
                      {plural(preview.routing.exclusions.length, "exclusion")}.
                      Proxy all websites:{" "}
                      {preview.routing.enabled ? "on" : "off"}. Global location:{" "}
                      {preview.routing.globalServerId
                        ? serverLabel(preview.routing.globalServerId)
                        : "none"}
                      .
                    </p>
                    <p>
                      {preview.format === "firefox"
                        ? "Your preferences, history, favorites and random mode stay as they are."
                        : `Also replaces your preferences, history${preview.favorites ? " and favorites" : ""}.`}
                    </p>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={async () => {
                        if (confirm("Replace your settings with this file?")) {
                          if (
                            await mutate({
                              type: "settings.import",
                              data: JSON.parse(importText),
                            })
                          )
                            setPreview(null);
                        }
                      }}
                    >
                      Confirm replacement
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </main>
      {isOptions ? (
        <footer>Requires Mullvad VPN · GPL-3.0-or-later</footer>
      ) : null}
    </div>
  );
}
