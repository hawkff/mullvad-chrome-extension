import { useEffect, useRef, useState } from "react";
import type { Command, CommandResult } from "../shared/messages";
import {
  type ConnectionObservation,
  type DnsObservation,
  type ImportPreview,
  INTERNAL_DEFAULT_SERVER_ID,
  type LoadState,
  type Snapshot,
} from "../shared/state";
import {
  client,
  freshness,
  incognitoScopeDescription,
  searchServers,
} from "./client";

const isOptions = location.pathname.endsWith("options.html");
const context = chrome.extension.inIncognitoContext ? "incognito" : "regular";

function Observation({
  title,
  state,
}: {
  title: string;
  state: LoadState<ConnectionObservation | DnsObservation[]>;
}) {
  const values =
    state.status === "ready"
      ? Array.isArray(state.value)
        ? state.value
        : [state.value]
      : [];
  return (
    <div className="observation">
      <h3>{title}</h3>
      <p>{freshness(state)}</p>
      {state.status === "ready" ? (
        values.length ? (
          <ul>
            {values.map((value) => (
              <li
                key={`${value.ip}-${"hostname" in value ? value.hostname : "connection"}`}
              >
                <strong>
                  {value.isMullvad
                    ? "Mullvad observed"
                    : "Non-Mullvad observed"}
                </strong>
                <br />
                {value.ip}
                {value.country ? ` · ${value.country}` : ""}
                {"hostname" in value ? (
                  <>
                    <br />
                    {value.hostname}
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>No resolvers observed. This does not confirm DNS protection.</p>
        )
      ) : null}
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [host, setHost] = useState("");
  const [tabId, setTabId] = useState<number>();
  const [target, setTarget] = useState<"global" | "site">("global");
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (picker) searchInput.current?.focus();
  }, [picker]);
  const [importText, setImportText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [section, setSection] = useState("routing");

  async function request<C extends Command>(
    command: C,
  ): Promise<CommandResult<C> | undefined> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await client({ ...command, context });
      if (!response.ok)
        throw new Error(`${response.error.code}: ${response.error.message}`);
      return response.value;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The request failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function mutate(
    command: Exclude<
      Command,
      { type: "settings.export" | "settings.import.preview" }
    >,
    reload = false,
  ) {
    const value = await request(command);
    if (value) {
      setSnapshot(value);
      setNotice(
        command.type === "snapshot"
          ? "Status refreshed."
          : command.type === "diagnostics.run"
            ? "Checks finished. Review the observations below."
            : "Settings updated.",
      );
      if (
        reload &&
        value.settings.preferences.autoReload &&
        tabId !== undefined
      ) {
        try {
          await chrome.tabs.reload(tabId);
        } catch {
          setError(
            "Settings saved, but Chrome could not reload the tab. Reload it manually.",
          );
        }
      }
    }
    return value;
  }
  useEffect(() => {
    let active = true;
    setBusy(true);
    client({ type: "snapshot", context })
      .then((response) => {
        if (!active) return;
        if (response.ok) setSnapshot(response.value);
        else setError(`${response.error.code}: ${response.error.message}`);
      })
      .catch((e: unknown) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "Cannot reach the extension.",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function activeSite() {
    setError("");
    try {
      // Request optional permissions directly in the click handler, before any command.
      if (!(await chrome.permissions.request({ permissions: ["tabs"] })))
        throw new Error(
          "Chrome denied tab access. Allow it to use the active website.",
        );
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.url || tab.incognito !== (context === "incognito"))
        throw new Error("No active website in this browsing context.");
      const url = new URL(tab.url);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("Open an HTTP or HTTPS website first.");
      setHost(url.hostname.toLowerCase().replace(/\.$/, ""));
      setTabId(tab.id);
      setTarget("site");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Cannot read the current website.",
      );
    }
  }
  async function privacy(
    control: "webRtcNonProxiedUdp" | "networkPrediction",
    enabled?: boolean,
  ) {
    setError("");
    try {
      if (!(await chrome.permissions.request({ permissions: ["privacy"] })))
        throw new Error("Chrome denied privacy access. No setting changed.");
      await mutate(
        enabled === undefined
          ? { type: "privacy.restore", control }
          : { type: "privacy.set", control, enabled },
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Cannot change Chrome privacy settings.",
      );
    }
  }
  async function select(serverId: string) {
    if (target === "site" && !host) {
      setError("Choose an active website first.");
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
        "Invalid JSON. Choose an unmodified Firefox export or a backup from this extension.",
      );
    }
  }
  const routing = snapshot?.settings.routing;
  const effective =
    context === "incognito" ? snapshot?.incognitoProxy : snapshot?.proxy;
  const servers =
    snapshot?.servers.status === "ready" ? snapshot.servers.value : [];
  const selected = servers.find((s) => s.id === routing?.globalServerId);
  const siteRule = routing?.rules.find((r) => r.host === host);
  const excluded = routing?.exclusions.includes(host) ?? false;
  return (
    <div className={isOptions ? "app options" : "app popup"}>
      <header>
        <div className="brand">
          <svg aria-hidden="true" width="28" height="28" viewBox="0 0 28 28">
            <path
              d="M4 7h20v14H4zM9 7V4h10v3M9 12h10M9 16h6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          <h1>Mullvad Proxy</h1>
        </div>
        <span>Unofficial Chrome port</span>
        {!isOptions ? (
          <button
            type="button"
            className="text"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            Settings
          </button>
        ) : null}
      </header>
      <main>
        <p className="context">
          {context === "incognito"
            ? "Incognito window · private session"
            : "Regular browsing"}
        </p>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <p className="feedback" role="status">
          {busy ? "Working…" : notice}
        </p>
        {!snapshot ? (
          <section aria-busy={busy}>
            <h2>Connecting to the extension</h2>
            <p>No connection or proxy status is available yet.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => mutate({ type: "snapshot" })}
            >
              Retry connection
            </button>
          </section>
        ) : (
          <>
            <section>
              <div className="heading">
                <h2>Browser proxy</h2>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => mutate({ type: "snapshot" })}
                >
                  Refresh status
                </button>
              </div>
              <strong className={effective?.applied ? "success" : "warning"}>
                {effective?.applied
                  ? "Proxy configuration applied"
                  : "Proxy configuration not confirmed"}
              </strong>
              <p>{effective?.message || `Status: ${effective?.status}`}</p>
              <p className="hint">Effective context: {effective?.scope}</p>
              {context === "incognito" ? (
                <p className="hint">
                  {incognitoScopeDescription(snapshot.incognitoProxy)} Routing
                  changes made here apply to this private session and expire
                  when the last Incognito window closes.
                </p>
              ) : null}
              <details open={isOptions || undefined}>
                <summary>Scope, ownership & requirements</summary>
                {!snapshot.incognitoAllowed ? (
                  <p className="hint">
                    Incognito access is off. Enable “Allow in Incognito” in
                    Chrome extension details, then open this popup in a private
                    window to check its effective status.
                  </p>
                ) : null}
                <p>
                  Ownership: {effective?.ownership.replaceAll("_", " ")}
                  <br />
                  Effective context: {effective?.scope} · setting:{" "}
                  {effective?.settingScope}
                </p>
                <p className="hint">
                  This extension does not connect the VPN. Mullvad SOCKS5
                  servers require a working Mullvad VPN connection. Direct
                  destinations remain direct.
                </p>
              </details>
            </section>
            {isOptions ? (
              <nav aria-label="Settings sections">
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
                <section>
                  <h2>Proxy routing</h2>
                  <fieldset disabled={busy}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={routing?.enabled ?? false}
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
                      Proxy all websites
                    </label>
                    <p>
                      {selected
                        ? `${selected.city}, ${selected.country} · ${selected.hostname}${selected.online ? "" : " · Offline"}`
                        : routing?.globalServerId === INTERNAL_DEFAULT_SERVER_ID
                          ? "VPN-internal SOCKS5 · 10.64.0.1:1080"
                          : routing?.globalServerId
                            ? `Unavailable server: ${routing.globalServerId}`
                            : "No global server selected"}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setTarget("global");
                        setPicker(!picker);
                      }}
                    >
                      Change global location
                    </button>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={routing?.randomMode ?? false}
                        onChange={(e) =>
                          mutate(
                            {
                              type: "settings.update",
                              patch: { randomMode: e.target.checked },
                            },
                            true,
                          )
                        }
                      />
                      Random mode
                    </label>
                    <p className="hint">
                      Session-stable selection per destination. Random mode can
                      override explicit proxy selections; exclusions remain
                      direct.
                    </p>
                    <h3>Current website</h3>
                    <button type="button" onClick={activeSite}>
                      Use active website
                    </button>
                    {host ? (
                      <>
                        <p className="hostname">{host}</p>
                        <p>
                          {excluded
                            ? "Excluded from proxying"
                            : siteRule
                              ? `${siteRule.enabled ? "Enabled" : "Disabled"} rule · ${siteRule.serverId}`
                              : "No exact website rule. Parent or global rules may apply."}
                        </p>
                        <div className="actions">
                          <button
                            type="button"
                            onClick={() => {
                              setTarget("site");
                              setPicker(true);
                            }}
                          >
                            Choose site location
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              mutate(
                                {
                                  type: "exclusion.set",
                                  host,
                                  excluded: !excluded,
                                },
                                true,
                              )
                            }
                          >
                            {excluded ? "Remove exclusion" : "Never proxy"}
                          </button>
                          {siteRule ? (
                            <button
                              type="button"
                              onClick={() =>
                                mutate({ type: "rule.remove", host }, true)
                              }
                            >
                              Reset site rule
                            </button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <p className="hint">
                        Allow optional tab access to configure the active
                        website.
                      </p>
                    )}
                  </fieldset>
                </section>
                {picker ? (
                  <section>
                    <div className="heading">
                      <h2>
                        {target === "site"
                          ? "Site location"
                          : "Global location"}
                      </h2>
                      <button type="button" onClick={() => setPicker(false)}>
                        Close
                      </button>
                    </div>
                    <label htmlFor="server-search">
                      Search country, city or server
                    </label>
                    <input
                      id="server-search"
                      ref={searchInput}
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <p>{freshness(snapshot.servers)}</p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => mutate({ type: "servers.refresh" })}
                    >
                      Refresh server list
                    </button>
                    <ul className="server-list">
                      {searchServers(servers, query).map((server) => (
                        <li key={server.id}>
                          <button
                            type="button"
                            disabled={busy || !server.online}
                            onClick={() => select(server.id)}
                          >
                            <strong>
                              {server.city}, {server.country}
                            </strong>
                            <span>
                              {server.hostname} ·{" "}
                              {server.online ? "Available" : "Offline"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {searchServers(servers, query).length === 0 ? (
                      <p>
                        No matching servers. Refresh the list or change your
                        search.
                      </p>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => select(INTERNAL_DEFAULT_SERVER_ID)}
                    >
                      Use VPN-internal default
                    </button>
                  </section>
                ) : null}
                {isOptions ? (
                  <section>
                    <h2>Website rules & exclusions</h2>
                    <p>
                      Rules match destination hosts, not the page that initiates
                      a request.
                    </p>
                    <fieldset disabled={busy}>
                      {routing?.rules.length === 0 &&
                      routing.exclusions.length === 0 ? (
                        <p>
                          No website rules. Use the active website controls
                          above to add one.
                        </p>
                      ) : null}
                      {routing?.rules.map((rule) => (
                        <div className="rule" key={rule.host}>
                          <label className="check">
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
                            <span>
                              {rule.host}
                              <small>{rule.serverId}</small>
                            </span>
                          </label>
                          <button
                            type="button"
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
                      {routing?.exclusions.map((item) => (
                        <div className="rule" key={item}>
                          <span>
                            {item} <small>Never proxy</small>
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
              <section>
                <div className="heading">
                  <h2>VPN & DNS check</h2>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      mutate({
                        type: "diagnostics.run",
                        checks: ["ipv4", "ipv6", "dns"],
                      })
                    }
                  >
                    Run checks
                  </button>
                </div>
                <p className="hint">
                  Browser route · IPv4 {snapshot.diagnostics.ipv4.status} · IPv6{" "}
                  {snapshot.diagnostics.ipv6.status} · DNS{" "}
                  {snapshot.diagnostics.dns.status}
                </p>
                <details>
                  <summary>Observations & check scope</summary>
                  <p className="hint">
                    Browser-route observations, not an active-tab check or proof
                    of DNS leak prevention. The browser proxy can affect these
                    results.
                  </p>
                  <Observation title="IPv4" state={snapshot.diagnostics.ipv4} />
                  <Observation title="IPv6" state={snapshot.diagnostics.ipv6} />
                  <Observation
                    title="DNS resolvers"
                    state={snapshot.diagnostics.dns}
                  />
                </details>
              </section>
            ) : null}
            {isOptions && section === "privacy" ? (
              <section>
                <h2>Chrome privacy</h2>
                <p>
                  Optional privacy permission:{" "}
                  {snapshot.privacy.permissionGranted
                    ? "Granted"
                    : "Not granted"}
                </p>
                <h3>WebRTC non-proxied UDP</h3>
                <p>
                  Current policy: {snapshot.privacy.webRtc.value ?? "Unknown"}
                  <br />
                  Ownership:{" "}
                  {snapshot.privacy.webRtc.ownership.replaceAll("_", " ")}
                </p>
                <p>
                  Restrict non-proxied UDP to reduce WebRTC IP exposure. This
                  does not disable WebRTC.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => privacy("webRtcNonProxiedUdp", true)}
                  >
                    Restrict non-proxied UDP
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => privacy("webRtcNonProxiedUdp")}
                  >
                    Restore WebRTC override
                  </button>
                </div>
                <h3>Network prediction</h3>
                <p>
                  Current state:{" "}
                  {snapshot.privacy.networkPrediction.value === null
                    ? "Unknown"
                    : snapshot.privacy.networkPrediction.value
                      ? "Enabled"
                      : "Disabled"}
                  <br />
                  Ownership:{" "}
                  {snapshot.privacy.networkPrediction.ownership.replaceAll(
                    "_",
                    " ",
                  )}
                </p>
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => privacy("networkPrediction", false)}
                  >
                    Disable prediction
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => privacy("networkPrediction")}
                  >
                    Restore prediction override
                  </button>
                </div>
                <h3>Recommended checks</h3>
                <p>
                  Review Chrome's “Use secure DNS” setting and your VPN DNS
                  configuration. Chrome cannot reproduce Firefox's per-site
                  proxy DNS controls.
                </p>
              </section>
            ) : null}
            {isOptions && section === "history" ? (
              <section>
                <h2>Location history</h2>
                <fieldset disabled={busy}>
                  <label className="check">
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
                    Remember location usage
                  </label>
                  <p>Incognito activity does not enter persistent history.</p>
                  {snapshot.history.length === 0 ? (
                    <p>No saved locations yet.</p>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm("Clear saved location history?"))
                            void mutate({ type: "history.clear" });
                        }}
                      >
                        Clear history
                      </button>
                      {snapshot.history.map((entry) => (
                        <div className="rule" key={entry.serverId}>
                          <span>
                            {entry.city}, {entry.country}
                            <small>
                              {entry.hostname} · Used {entry.count} times ·{" "}
                              {new Date(entry.lastUsedAt).toLocaleString()}
                            </small>
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setTarget("global");
                              setPicker(true);
                              setSection("routing");
                              setQuery(entry.hostname);
                            }}
                          >
                            Use location
                          </button>
                          <button
                            type="button"
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
                    </>
                  )}
                </fieldset>
              </section>
            ) : null}
            {isOptions && section === "backup" ? (
              <section>
                <h2>Import / export</h2>
                <p>
                  Import a native backup or upstream Firefox settings JSON.
                  Incompatible endpoints and Firefox-only DNS settings require
                  correction before import.
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
                            : "Cannot read this file.",
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
                        : "Native backup"}{" "}
                      ready to import
                    </h3>
                    <p>
                      This replaces existing routes with{" "}
                      {preview.routing.rules.length} rules and{" "}
                      {preview.routing.exclusions.length} exclusions. Global
                      server: {preview.routing.globalServerId ?? "None"}. Global
                      routing:{" "}
                      {preview.routing.enabled ? "Enabled" : "Disabled"}.
                    </p>
                    <p>
                      {preview.format === "firefox"
                        ? "Existing preferences, history and random mode stay unchanged."
                        : "Preferences and history will also be replaced."}
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={async () => {
                        if (
                          confirm(
                            "Replace existing settings with this validated import?",
                          )
                        ) {
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
            {isOptions ? (
              <section>
                <h2>Preferences & Incognito</h2>
                <fieldset disabled={busy}>
                  <label className="check">
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
                    Reload the active website after routing changes
                  </label>
                </fieldset>
                <p>
                  Incognito access:{" "}
                  {snapshot.incognitoAllowed
                    ? "Allowed by Chrome"
                    : "Not allowed"}
                  . Open Chrome → Extensions → Manage extensions → this
                  extension → Allow in Incognito to opt in.
                </p>
                {context === "regular" ? (
                  <p>
                    This regular page does not inspect or monitor private
                    routing.
                  </p>
                ) : null}
                <p>
                  Open the popup in an Incognito window to see effective
                  private-context ownership. Incognito diagnostics may be
                  blocked when Chrome cannot guarantee context-correct checks.
                  Regular routing applies until you create a private-session
                  override. Private routing changes and activity expire when the
                  last Incognito window closes.
                </p>
              </section>
            ) : null}
          </>
        )}
      </main>
      <footer>
        Requires Mullvad VPN · GPL-3.0-or-later
        <br />
        Independent port. Not an official Mullvad product.
      </footer>
    </div>
  );
}
