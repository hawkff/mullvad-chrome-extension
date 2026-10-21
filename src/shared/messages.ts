import type {
  BrowserContext,
  ImportPreview,
  Preferences,
  SettingsExport,
  SiteRule,
  Snapshot,
} from "./state";

export type Command = { context?: BrowserContext } & (
  | { type: "snapshot" }
  | {
      type: "settings.update";
      patch: Partial<Preferences> & { enabled?: boolean; randomMode?: boolean };
    }
  | { type: "server.select"; serverId: string; host?: string }
  | { type: "rule.upsert"; rule: SiteRule }
  | { type: "rule.remove"; host: string }
  | { type: "exclusion.set"; host: string; excluded: boolean }
  | { type: "servers.refresh" }
  | { type: "diagnostics.run"; checks: ("ipv4" | "ipv6" | "dns")[] }
  | {
      type: "privacy.set";
      control: "webRtcNonProxiedUdp" | "networkPrediction";
      enabled: boolean;
    }
  | {
      type: "privacy.restore";
      control: "webRtcNonProxiedUdp" | "networkPrediction";
    }
  | { type: "history.clear" }
  | { type: "history.remove"; serverId: string }
  | { type: "settings.export" }
  | { type: "settings.import.preview"; data: unknown }
  | { type: "settings.import"; data: unknown }
);

export type CommandResult<C extends Command> = C extends {
  type: "settings.export";
}
  ? SettingsExport
  : C extends { type: "settings.import.preview" }
    ? ImportPreview
    : Snapshot;
export type Response<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code:
          | "invalid-input"
          | "permission-denied"
          | "blocked"
          | "offline"
          | "internal";
        message: string;
      };
    };
export type CommandClient = <C extends Command>(
  command: C,
) => Promise<Response<CommandResult<C>>>;
