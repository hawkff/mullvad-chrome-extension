import { useEffect, useRef, useState } from "react";
import { checked, relayName, host as validateHost } from "../core/validation";
import type { Command, CommandResult } from "../shared/messages";
import {
  type BrowserContext,
  type ImportPreview,
  INTERNAL_DEFAULT_SERVER_ID,
  type Snapshot,
} from "../shared/state";
import {
  checkStatus,
  client,
  currentWebsiteTab,
  exitStatus,
  freshness,
  incognitoScopeDescription,
  type Observed,
  proxyStatus,
  STALE_AFTER,
  searchServers,
  type Tone,
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

function Observation({ title, state }: { title: string; state: Observed }) {
  const values =
    state.status === "ready"
      ? Array.isArray(state.value)
        ? state.value
        : [state.value]
      : [];
  return (
    <div className="observation">
      <h3>{title}</h3>
      <p className="meta">{freshness(state)}</p>
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
                <span className="data">{value.ip}</span>
                {value.country ? ` · ${value.country}` : ""}
                {"hostname" in value && value.hostname ? (
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
            : command.type === "servers.refresh"
              ? "Server list updated."
              : "Settings updated.",
      );
      if (reload && value.settings.preferences.autoReload && !isOptions) {
        try {
          const tab = await currentWebsiteTab(context);
          await chrome.tabs.reload(tab.id);
        } catch (error) {
          setError(
            `Settings saved, but the active website was not reloaded. ${error instanceof Error ? error.message : "Reload it manually."}`,
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
  }, [context]);

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
  async function activeSite() {
    setError("");
    try {
      // Request optional permissions directly in the click handler, before any command.
      if (!(await chrome.permissions.request({ permissions: ["tabs"] })))
        throw new Error(
          "Chrome denied tab access. Allow it to use the active website.",
        );
      const tab = await currentWebsiteTab(context);
      const url = new URL(tab.url);
      setHost(url.hostname.toLowerCase().replace(/\.$/, ""));
      setTarget("site");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Cannot read the current website.",
      );
    }
  }
  async function setAutoReload(enabled: boolean) {
    setError("");
    try {
      if (
        enabled &&
        !(await chrome.permissions.request({ permissions: ["tabs"] }))
      )
        throw new Error(
          "Chrome denied tab access. Active-website reload was not enabled.",
        );
      await mutate({ type: "settings.update", patch: { autoReload: enabled } });
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Cannot enable active-website reload.",
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
  const serverLabel = (id: string) => {
    if (id === INTERNAL_DEFAULT_SERVER_ID)
      return "VPN-internal SOCKS5 · 10.64.0.1:1080";
    const server = servers.find((row) => row.id === id);
    return server
      ? `${server.city}, ${server.country} · ${relayName(server.hostname)}${server.online ? "" : " · Offline"}`
      : `Unavailable server: ${id}`;
  };
  const selected = servers.find((s) => s.id === routing?.globalServerId);
  const canonical = checked(() => validateHost(host));
  const siteRule = canonical.ok
    ? routing?.rules.find((r) => r.host === canonical.value)
    : undefined;
  const excluded =
    canonical.ok && (routing?.exclusions.includes(canonical.value) ?? false);
  const matches = picker ? searchServers(servers, query) : [];
  const current =
    target === "site" ? siteRule?.serverId : routing?.globalServerId;
  const status = snapshot
    ? proxyStatus(
        snapshot,
        context,
        selected
          ? `${selected.city}, ${selected.country}`
          : routing?.globalServerId === INTERNAL_DEFAULT_SERVER_ID
            ? "the VPN-internal proxy"
            : "an unavailable server",
      )
    : undefined;
  const checks = snapshot
    ? ([
        ["IPv4", snapshot.diagnostics.ipv4],
        ["IPv6", snapshot.diagnostics.ipv6],
        ["DNS", snapshot.diagnostics.dns],
      ] as const)
    : [];

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
          {matches.map((server, index) => {
            const previous = matches[index - 1];
            const country = server.country !== previous?.country;
            return (
              <li key={server.id}>
                {country ? <h3 className="country">{server.country}</h3> : null}
                {country || server.city !== previous?.city ? (
                  <h4 className="city">{server.city}</h4>
                ) : null}
                <button
                  type="button"
                  disabled={busy || !server.online}
                  aria-current={server.id === current || undefined}
                  onClick={() => select(server.id)}
                >
                  <span className="relay">
                    <span className="sr-only">{server.city}, </span>
                    {relayName(server.hostname)}
                  </span>
                  <span className="state">
                    {server.id === current ? (
                      <>
                        <Mark tone="on" /> In use
                      </>
                    ) : server.online ? null : (
                      "Offline"
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {matches.length === 0 ? (
          <p>No matching servers. Refresh the list or change your search.</p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => select(INTERNAL_DEFAULT_SERVER_ID)}
        >
          Use VPN-internal default
        </button>
      </section>
    ) : null;

  const settingsButton = isOptions ? null : (
    <button
      type="button"
      className="ghost"
      title={
        context === "incognito"
          ? "Opens regular, persistent settings"
          : undefined
      }
      onClick={() => chrome.runtime.openOptionsPage()}
    >
      {context === "incognito" ? "Regular settings" : "Settings"}
    </button>
  );

  return (
    <div className={isOptions ? "app options" : "app popup"}>
      <header>
        <div className="brand">
          <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9M12 3C9.5 5.6 8.2 8.6 8.2 12s1.3 6.4 3.8 9" />
          </svg>
          <h1>Mullvad Proxy</h1>
          <span className="tag">Unofficial</span>
        </div>
        {context === "regular" ? settingsButton : null}
        {!isOptions && snapshot && status ? (
          <ul className="pills" aria-label="Status summary">
            {(
              [
                ["Proxy", status.tone, status.title],
                ["VPN", ...exitStatus(snapshot)],
                ["DNS", ...checkStatus(snapshot.diagnostics.dns)],
              ] as const
            ).map(([name, tone, text]) => {
              // Connection checks observe browser requests, not the VPN tunnel itself.
              const label = name === "Proxy" ? text : `Browser check: ${text}`;
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
          <section className="card" aria-busy={busy}>
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
        ) : !isOptions && picker ? (
          locationPicker
        ) : (
          <>
            <section className="card" aria-labelledby="status-title">
              <div className="card-head">
                <h2 id="status-title">Browser proxy</h2>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => mutate({ type: "snapshot" })}
                >
                  Refresh status
                </button>
              </div>
              <p className="status" data-tone={status.tone}>
                <Mark tone={status.tone} />
                <span>
                  <strong>{status.title}</strong> {status.detail}
                </span>
              </p>
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
                <p className="hint">
                  Ownership: {effective.ownership.replaceAll("_", " ")}
                  <br />
                  Effective context: {effective.scope} · setting:{" "}
                  {effective.settingScope}
                </p>
                <p className="hint">
                  This extension does not connect the VPN. Mullvad SOCKS5
                  servers require a working Mullvad VPN connection. Direct
                  destinations remain direct.
                </p>
              </details>
            </section>
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
                          : "No global server selected"}
                      </p>
                      <button
                        type="button"
                        className="primary"
                        onClick={() =>
                          picker && target === "global"
                            ? setPicker(false)
                            : openPicker("global")
                        }
                      >
                        Change global location
                      </button>
                    </div>
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
                        Session-stable selection per destination. Random mode
                        overrides global and website selections and all
                        exclusions. Local address bypasses still apply.
                      </p>
                    </div>
                    <div className="row">
                      <h3>
                        {isOptions ? "Website domain" : "Current website"}
                      </h3>
                      {isOptions ? (
                        <>
                          <label htmlFor="website-domain">
                            Domain or subdomain
                          </label>
                          <input
                            id="website-domain"
                            type="text"
                            placeholder="example.com"
                            autoCapitalize="none"
                            spellCheck={false}
                            value={host}
                            onChange={(event) => setHost(event.target.value)}
                          />
                          <p className="hint">
                            Enter a domain without a URL or port. A registrable
                            parent domain also covers its subdomains.
                          </p>
                        </>
                      ) : (
                        <button type="button" onClick={activeSite}>
                          Use active website
                        </button>
                      )}
                      {host ? (
                        <>
                          {!isOptions ? (
                            <>
                              <p className="hostname">{host}</p>
                              <p className="meta">
                                {excluded
                                  ? routing.randomMode
                                    ? "Exclusion saved but inactive while random mode is on"
                                    : "Excluded when random mode is off"
                                  : siteRule
                                    ? `${siteRule.enabled ? "Enabled" : "Disabled"} rule · ${serverLabel(siteRule.serverId)}`
                                    : "No exact website rule. Parent or global rules may apply."}
                              </p>
                            </>
                          ) : null}
                          <div className="actions">
                            <button
                              type="button"
                              className="primary"
                              onClick={() => openPicker("site")}
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
                              {excluded ? "Remove exclusion" : "Add exclusion"}
                            </button>
                            {siteRule ? (
                              <button
                                type="button"
                                className="danger"
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
                          {isOptions
                            ? "Enter a domain above to choose its location or add an exclusion without visiting it."
                            : "Allow optional tab access to configure the active website."}
                        </p>
                      )}
                    </div>
                  </fieldset>
                </section>
                {isOptions ? locationPicker : null}
                {isOptions ? (
                  <section className="card">
                    <h2>Website rules & exclusions</h2>
                    <p className="hint">
                      Rules match destination hosts, not the page that initiates
                      a request.
                    </p>
                    {routing.randomMode ? (
                      <p role="status" className="notice">
                        Random mode is on. Saved exclusions are inactive; these
                        destinations use random routing.
                      </p>
                    ) : null}
                    <fieldset disabled={busy}>
                      {routing.rules.length === 0 &&
                      routing.exclusions.length === 0 ? (
                        <p className="empty">
                          No website rules. Enter a domain above to add a rule
                          or exclusion.
                        </p>
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
                                : "Direct while random mode is off"}
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
              <section className="card">
                <div className="card-head">
                  <h2>VPN & DNS check</h2>
                  <button
                    type="button"
                    className="primary"
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
                <ul className="checks">
                  {checks.map(([name, state]) => {
                    const [tone, text] = checkStatus(state);
                    return (
                      <li key={name}>
                        <Mark tone={tone} />
                        <span className="check-name">{name}</span>
                        <span className="data">{text}</span>
                      </li>
                    );
                  })}
                </ul>
                <details>
                  <summary>Observations & check scope</summary>
                  <p className="hint">
                    Browser-route observations, not an active-tab check or proof
                    of DNS leak prevention. The browser proxy can affect these
                    results.
                  </p>
                  {checks.map(([name, state]) => (
                    <Observation
                      key={name}
                      title={name === "DNS" ? "DNS resolvers" : name}
                      state={state}
                    />
                  ))}
                </details>
              </section>
            ) : null}
            {isOptions && section === "privacy" ? (
              <section className="card">
                <h2>Chrome privacy</h2>
                <p className="meta">
                  Optional privacy permission:{" "}
                  {snapshot.privacy.permissionGranted
                    ? "Granted"
                    : "Not granted"}
                </p>
                <div className="row">
                  <h3>WebRTC non-proxied UDP</h3>
                  <p className="meta">
                    Current policy: {snapshot.privacy.webRtc.value ?? "Unknown"}{" "}
                    · Ownership:{" "}
                    {snapshot.privacy.webRtc.ownership.replaceAll("_", " ")}
                  </p>
                  <p className="hint">
                    Restrict non-proxied UDP to reduce WebRTC IP exposure. This
                    does not disable WebRTC.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
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
                </div>
                <div className="row">
                  <h3>Network prediction</h3>
                  <p className="meta">
                    Current state:{" "}
                    {snapshot.privacy.networkPrediction.value === null
                      ? "Unknown"
                      : snapshot.privacy.networkPrediction.value
                        ? "Enabled"
                        : "Disabled"}{" "}
                    · Ownership:{" "}
                    {snapshot.privacy.networkPrediction.ownership.replaceAll(
                      "_",
                      " ",
                    )}
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="primary"
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
                </div>
                <div className="row">
                  <h3>Recommended checks</h3>
                  <p className="hint">
                    Review Chrome's “Use secure DNS” setting and your VPN DNS
                    configuration. Chrome cannot reproduce Firefox's per-site
                    proxy DNS controls.
                  </p>
                </div>
              </section>
            ) : null}
            {isOptions && section === "history" ? (
              <section className="card">
                <h2>Location history</h2>
                <fieldset disabled={busy}>
                  <label className="switch">
                    <span>Remember location usage</span>
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
                    Incognito activity does not enter persistent history.
                  </p>
                  {snapshot.history.length === 0 ? (
                    <p className="empty">No saved locations yet.</p>
                  ) : (
                    <>
                      {snapshot.history.map((entry) => (
                        <div className="rule" key={entry.serverId}>
                          <span>
                            {entry.city}, {entry.country}
                            <small>
                              {relayName(entry.hostname)} · Used {entry.count}{" "}
                              {entry.count === 1 ? "time" : "times"} ·{" "}
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
                          if (confirm("Clear saved location history?"))
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
                      className="danger"
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
              <section className="card">
                <h2>Preferences & Incognito</h2>
                <fieldset disabled={busy}>
                  <label className="switch">
                    <span>
                      Reload the active website after popup routing changes
                    </span>
                    <input
                      type="checkbox"
                      checked={snapshot.settings.preferences.autoReload}
                      onChange={(e) => setAutoReload(e.target.checked)}
                    />
                  </label>
                </fieldset>
                <p className="hint">
                  One preference for regular and Incognito popups. Reloads only
                  the active HTTP or HTTPS website in the popup's window.
                  Options changes never reload a website.
                </p>
                <div className="row">
                  <p className="meta">
                    Incognito access:{" "}
                    {snapshot.incognitoAllowed
                      ? "Allowed by Chrome"
                      : "Not allowed"}
                    . Open Chrome → Extensions → Manage extensions → this
                    extension → Allow in Incognito to opt in.
                  </p>
                  {context === "regular" ? (
                    <p className="hint">
                      This regular page does not inspect or monitor private
                      routing.
                    </p>
                  ) : null}
                  <p className="hint">
                    Open the popup in an Incognito window to see effective
                    private-context ownership. Incognito diagnostics may be
                    blocked when Chrome cannot guarantee context-correct checks.
                    Regular routing applies until you create a private-session
                    override. Private routing changes and activity expire when
                    the last Incognito window closes.
                  </p>
                </div>
              </section>
            ) : null}
          </>
        )}
      </main>
      <footer>
        {isOptions ? (
          <>
            Requires Mullvad VPN · GPL-3.0-or-later
            <br />
            Independent port. Not an official Mullvad product.
          </>
        ) : (
          "Unofficial port · Requires Mullvad VPN · GPL-3.0-or-later"
        )}
      </footer>
    </div>
  );
}
