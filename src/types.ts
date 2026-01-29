import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";

export type NapcatAccountConfig = {
  name?: string;
  enabled?: boolean;
  wsUrl?: string;
  httpUrl?: string;
  accessToken?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
};

export type NapcatConfig = NapcatAccountConfig & {
  accounts?: Record<string, NapcatAccountConfig | undefined>;
};

export type ResolvedNapcatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  wsUrl?: string;
  httpUrl?: string;
  accessToken?: string;
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  mediaMaxMb?: number;
  config: NapcatAccountConfig;
};

function getNapcatConfig(cfg: MoltbotConfig): NapcatConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.napcat as
    | NapcatConfig
    | undefined;
}

export function listNapcatAccountIds(cfg: MoltbotConfig): string[] {
  const napcatCfg = getNapcatConfig(cfg);
  const accountIds = Object.keys(napcatCfg?.accounts ?? {});
  if (accountIds.length > 0) {
    return accountIds.map((id) => normalizeAccountId(id));
  }
  if (napcatCfg?.wsUrl || napcatCfg?.httpUrl) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [];
}

export function resolveDefaultNapcatAccountId(cfg: MoltbotConfig): string {
  const ids = listNapcatAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveNapcatAccount(opts: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}): ResolvedNapcatAccount {
  const accountId = normalizeAccountId(opts.accountId ?? DEFAULT_ACCOUNT_ID);
  const napcatCfg = getNapcatConfig(opts.cfg);
  const baseConfig: NapcatAccountConfig = napcatCfg
    ? {
        name: napcatCfg.name,
        enabled: napcatCfg.enabled,
        wsUrl: napcatCfg.wsUrl,
        httpUrl: napcatCfg.httpUrl,
        accessToken: napcatCfg.accessToken,
        dmPolicy: napcatCfg.dmPolicy,
        allowFrom: napcatCfg.allowFrom,
        textChunkLimit: napcatCfg.textChunkLimit,
        chunkMode: napcatCfg.chunkMode,
        mediaMaxMb: napcatCfg.mediaMaxMb,
      }
    : {};
  const accountOverride = napcatCfg?.accounts?.[accountId] ?? {};
  const config = {
    ...baseConfig,
    ...accountOverride,
  };
  const wsUrl = config.wsUrl?.trim() || undefined;
  const httpUrl = config.httpUrl?.trim() || undefined;
  const accessToken = config.accessToken?.trim() || undefined;
  const configured = Boolean(wsUrl);
  return {
    accountId,
    name: config.name?.trim() || undefined,
    enabled: config.enabled !== false,
    configured,
    wsUrl,
    httpUrl,
    accessToken,
    textChunkLimit: config.textChunkLimit,
    chunkMode: config.chunkMode,
    mediaMaxMb: config.mediaMaxMb,
    config,
  };
}
