import { validatePersistedSettings } from "../core/index";
import type { HistoryEntry, Server, Settings } from "../shared/state";
import { object } from "./platform";
export interface Stored {
  version: 1;
  revision: number;
  settings: Settings;
  history: HistoryEntry[];
}
export interface Session {
  seed: string;
  pool: Server[];
  privateState?: Stored;
  privateSeed?: string;
  privateWindows?: number[];
}
export function defaults(): Stored {
  return {
    version: 1,
    revision: 0,
    settings: {
      routing: {
        enabled: false,
        globalServerId: null,
        randomMode: false,
        rules: [],
        exclusions: [],
      },
      preferences: { autoReload: false, historyEnabled: true },
    },
    history: [],
  };
}
export function validateStored(input: unknown): Stored {
  if (
    !object(input) ||
    input.version !== 1 ||
    !Number.isSafeInteger(input.revision) ||
    typeof input.revision !== "number" ||
    input.revision < 0
  )
    throw new Error(
      "Invalid saved settings; export/recover storage before resetting it.",
    );
  const result = validatePersistedSettings({
    version: 1,
    settings: input.settings,
    history: input.history,
  });
  if (!result.ok || !result.value.preferences || !result.value.history)
    throw new Error("Invalid saved settings; no data was overwritten.");
  return {
    version: 1,
    revision: input.revision,
    settings: {
      routing: {
        ...result.value.routing,
        randomMode: result.value.routing.randomMode ?? false,
      },
      preferences: result.value.preferences,
    },
    history: result.value.history,
  };
}
export function validPool(input: unknown): Server[] {
  if (!Array.isArray(input) || input.length > 10000)
    throw new Error("Invalid server cache");
  return input.map((row: unknown) => {
    if (
      !object(row) ||
      ![
        "id",
        "hostname",
        "ipv4",
        "ipv6",
        "country",
        "countryCode",
        "city",
      ].every((key) => typeof row[key] === "string" && row[key].length < 256) ||
      typeof row.online !== "boolean" ||
      !Number.isInteger(row.port) ||
      typeof row.port !== "number" ||
      row.port < 1 ||
      row.port > 65535
    )
      throw new Error("Invalid server cache");
    if (
      row.id !== row.hostname ||
      !/^[a-z0-9.-]+$/.test(String(row.hostname)) ||
      !/^(\d{1,3}\.){3}\d{1,3}$/.test(String(row.ipv4)) ||
      !String(row.ipv4)
        .split(".")
        .every((part) => Number(part) <= 255)
    )
      throw new Error("Invalid server cache");
    return row as unknown as Server;
  });
}
export async function read(
  area: chrome.storage.StorageArea,
  key: string,
): Promise<unknown> {
  return (await area.get(key))[key];
}
export function write(
  area: chrome.storage.StorageArea,
  key: string,
  value: unknown,
): Promise<void> {
  return area.set({ [key]: value });
}
