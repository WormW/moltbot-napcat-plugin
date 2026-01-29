import {
  PAIRING_APPROVED_MESSAGE,
  buildChannelConfigSchema,
  createReplyPrefixContext,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  setAccountEnabledInConfigSection,
  stripMarkdown,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type MoltbotConfig,
  type ReplyPayload,
} from "clawdbot/plugin-sdk";

import { NapcatConfigSchema } from "./config-schema.js";
import { createOneBotConnection, type OneBotEventPayload } from "./onebot-connection.js";
import { getNapcatRuntime } from "./runtime.js";
import {
  listNapcatAccountIds,
  resolveDefaultNapcatAccountId,
  resolveNapcatAccount,
  type ResolvedNapcatAccount,
} from "./types.js";

type OneBotMessageSegment = {
  type?: string;
  data?: Record<string, string>;
};

const DEFAULT_TEXT_LIMIT = 2000;
const activeConnections = new Map<string, ReturnType<typeof createOneBotConnection>>();

function normalizeAllowEntry(entry: string | number): string {
  const value = String(entry ?? "").trim();
  if (!value) return "";
  if (value === "*") return "*";
  return value.replace(/^(qq|user):/i, "");
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  const normalized = entries.map((entry) => normalizeAllowEntry(entry)).filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  const normalized = normalizeAllowEntry(senderId);
  if (allowFrom.includes("*")) return true;
  return allowFrom.includes(normalized);
}

function normalizeTarget(raw: string): string {
  return String(raw ?? "").trim().replace(/^(qq|user):/i, "");
}

function formatTarget(id: string | number): string {
  return `qq:${id}`;
}

function parseUserId(target: string): number {
  const normalized = normalizeTarget(target);
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid QQ target: ${target}`);
  }
  return parsed;
}

function resolveTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

function isLikelyMediaRef(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^(https?|file|base64):/i.test(trimmed)) return true;
  if (trimmed.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  return false;
}

function parseOneBotMessage(message: unknown): {
  text: string;
  mediaUrls: string[];
  mediaTypes: string[];
} {
  const textParts: string[] = [];
  const mediaUrls: string[] = [];
  const mediaTypes: string[] = [];

  if (typeof message === "string") {
    textParts.push(message);
  } else if (Array.isArray(message)) {
    for (const segment of message) {
      const typed = segment as OneBotMessageSegment;
      const type = typed?.type;
      if (type === "text") {
        const text = typed?.data?.text;
        if (typeof text === "string") textParts.push(text);
        continue;
      }
      if (type === "image" || type === "record" || type === "video") {
        const url = typed?.data?.url ?? typed?.data?.file ?? "";
        if (typeof url === "string" && isLikelyMediaRef(url)) {
          mediaUrls.push(url);
          mediaTypes.push(
            type === "record" ? "audio" : type === "video" ? "video" : "image",
          );
        }
      }
    }
  }

  return {
    text: textParts.join(""),
    mediaUrls,
    mediaTypes,
  };
}

function describeMediaSummary(mediaTypes: string[]): string {
  if (mediaTypes.length === 0) return "";
  const unique = Array.from(new Set(mediaTypes));
  if (unique.length === 1) {
    const typeLabel = unique[0] ?? "media";
    const count = mediaTypes.length;
    if (count === 1) {
      return `sent a ${typeLabel} attachment`;
    }
    return `sent ${count} ${typeLabel} attachments`;
  }
  return "sent media attachments";
}

async function resolveMediaSegmentType(
  mediaUrl: string,
): Promise<"image" | "record" | "video" | null> {
  const runtime = getNapcatRuntime();
  if (/^base64:\/\//i.test(mediaUrl)) return "image";
  const mime = await runtime.media.detectMime({ filePath: mediaUrl });
  const kind = runtime.media.mediaKindFromMime(mime);
  if (kind === "image") return "image";
  if (kind === "audio") return "record";
  if (kind === "video") return "video";
  return null;
}

function buildTextSegment(text: string): OneBotMessageSegment {
  return { type: "text", data: { text } };
}

function buildMediaSegment(type: "image" | "record" | "video", file: string): OneBotMessageSegment {
  return { type, data: { file } };
}

function buildHttpUrl(base: string, action: string, accessToken?: string): string {
  const parsed = new URL(base);
  const basePath = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  parsed.pathname = `${basePath}/${action}`;
  if (accessToken && !parsed.searchParams.has("access_token")) {
    parsed.searchParams.set("access_token", accessToken);
  }
  return parsed.toString();
}

async function sendActionHttp(
  account: ResolvedNapcatAccount,
  action: string,
  params?: Record<string, unknown>,
): Promise<{ status: string; retcode: number; data?: Record<string, unknown> | null }> {
  if (!account.httpUrl) {
    throw new Error("Napcat httpUrl not configured");
  }
  const url = buildHttpUrl(account.httpUrl, action, account.accessToken);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: params ? JSON.stringify(params) : "{}",
  });
  if (!response.ok) {
    throw new Error(`Napcat HTTP error (${action}): ${response.status}`);
  }
  return (await response.json()) as {
    status: string;
    retcode: number;
    data?: Record<string, unknown> | null;
  };
}

async function sendOneBotAction(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  action: string;
  params?: Record<string, unknown>;
}): Promise<{ status: string; retcode: number; data?: Record<string, unknown> | null }> {
  const account = resolveNapcatAccount({ cfg: params.cfg, accountId: params.accountId });
  const connection = activeConnections.get(account.accountId);
  if (connection) {
    return await connection.sendAction(params.action, params.params);
  }
  return await sendActionHttp(account, params.action, params.params);
}

function resolveMessageId(response: { data?: Record<string, unknown> | null }): string {
  const messageId = response.data?.message_id;
  if (typeof messageId === "number" || typeof messageId === "string") {
    return String(messageId);
  }
  return String(Date.now());
}

async function sendNapcatText(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  to: string;
  text: string;
}): Promise<{ messageId: string; chatId: string }> {
  const userId = parseUserId(params.to);
  const message = [buildTextSegment(params.text)];
  const response = await sendOneBotAction({
    cfg: params.cfg,
    accountId: params.accountId,
    action: "send_private_msg",
    params: { user_id: userId, message },
  });
  if (response.status === "failed") {
    throw new Error(`Napcat send failed (retcode ${response.retcode})`);
  }
  return { messageId: resolveMessageId(response), chatId: String(userId) };
}

async function sendNapcatMedia(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
  to: string;
  text: string;
  mediaUrl: string;
}): Promise<{ messageId: string; chatId: string }> {
  const mediaType = await resolveMediaSegmentType(params.mediaUrl);
  if (!mediaType) {
    const fallback = params.text ? `${params.text}\n${params.mediaUrl}` : params.mediaUrl;
    return await sendNapcatText({
      cfg: params.cfg,
      accountId: params.accountId,
      to: params.to,
      text: fallback,
    });
  }
  const userId = parseUserId(params.to);
  const segments: OneBotMessageSegment[] = [];
  if (params.text) segments.push(buildTextSegment(params.text));
  segments.push(buildMediaSegment(mediaType, params.mediaUrl));
  const response = await sendOneBotAction({
    cfg: params.cfg,
    accountId: params.accountId,
    action: "send_private_msg",
    params: { user_id: userId, message: segments },
  });
  if (response.status === "failed") {
    throw new Error(`Napcat send failed (retcode ${response.retcode})`);
  }
  return { messageId: resolveMessageId(response), chatId: String(userId) };
}

async function handlePrivateMessage(params: {
  cfg: MoltbotConfig;
  account: ResolvedNapcatAccount;
  event: OneBotEventPayload;
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void; error?: (msg: string) => void };
  statusSink?: (next: Partial<ChannelAccountSnapshot>) => void;
}): Promise<void> {
  const core = getNapcatRuntime();
  const event = params.event;
  const postType = typeof event.post_type === "string" ? event.post_type : "";
  const messageType = typeof event.message_type === "string" ? event.message_type : "";
  if (postType !== "message") return;
  if (messageType !== "private") return;

  const rawUserId =
    typeof event.user_id === "number" || typeof event.user_id === "string"
      ? event.user_id
      : null;
  if (rawUserId == null) return;
  const senderId = String(rawUserId);
  if (
    (typeof event.self_id === "number" || typeof event.self_id === "string") &&
    String(event.self_id) === senderId
  ) {
    return;
  }

  const sender = (event.sender as Record<string, unknown> | undefined) ?? undefined;
  const senderName =
    (typeof sender?.nickname === "string" ? sender.nickname.trim() : "") || senderId;
  const parsedMessage = parseOneBotMessage(event.message);
  const rawMessage = typeof event.raw_message === "string" ? event.raw_message.trim() : "";
  const bodyText = (parsedMessage.text || rawMessage).trim();
  const mediaSummary = bodyText ? "" : describeMediaSummary(parsedMessage.mediaTypes);
  const combinedText = bodyText || mediaSummary;
  const commandText = parsedMessage.text.trim();
  if (parsedMessage.mediaUrls.length > 0) {
    params.log?.info?.(
      `napcat inbound media: sender=${senderId} types=${parsedMessage.mediaTypes.join(",") || "unknown"} urls=${parsedMessage.mediaUrls.join(",")}`,
    );
  } else if (rawMessage.includes("[CQ:image") || rawMessage.includes("[CQ:record") || rawMessage.includes("[CQ:video")) {
    params.log?.warn?.(
      `napcat inbound media not parsed: sender=${senderId} raw_message=${rawMessage.slice(0, 200)}`,
    );
  }

  const dmPolicy = params.account.config.dmPolicy ?? "open";
  const configAllowFrom = normalizeAllowList(params.account.config.allowFrom ?? []);
  const storedAllowFrom = normalizeAllowList(
    await core.channel.pairing.readAllowFromStore("napcat").catch(() => []),
  );
  const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storedAllowFrom]));
  const senderAllowed = isSenderAllowed(senderId, effectiveAllowFrom);
  const commandAuthorized = dmPolicy === "open" || senderAllowed;

  if (dmPolicy === "disabled") return;
  if (dmPolicy !== "open" && !senderAllowed) {
    if (dmPolicy === "pairing") {
      const { code, created } = await core.channel.pairing.upsertPairingRequest({
        channel: "napcat",
        id: senderId,
        meta: { name: senderName },
      });
      if (created) {
        await sendNapcatText({
          cfg: params.cfg,
          accountId: params.account.accountId,
          to: formatTarget(senderId),
          text: core.channel.pairing.buildPairingReply({
            channel: "napcat",
            idLine: `Your QQ: ${senderId}`,
            code,
          }),
        });
        params.statusSink?.({ lastOutboundAt: Date.now() });
      }
    }
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "napcat",
    accountId: params.account.accountId,
    peer: { kind: "dm", id: senderId },
  });

  const timestamp = resolveTimestampMs(event.time);
  const envelope = core.channel.reply.formatInboundEnvelope({
    channel: "Napcat",
    from: senderName,
    timestamp,
    body: combinedText,
    chatType: "direct",
    sender: { name: senderName, id: senderId },
  });

  const to = formatTarget(senderId);
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: envelope,
    RawBody: commandText,
    CommandBody: commandText,
    From: formatTarget(senderId),
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: senderName,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "napcat" as const,
    Surface: "napcat" as const,
    MessageSid:
      typeof event.message_id === "number" || typeof event.message_id === "string"
        ? String(event.message_id)
        : undefined,
    Timestamp: timestamp,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "napcat" as const,
    OriginatingTo: to,
    MediaUrl: parsedMessage.mediaUrls[0],
    MediaUrls: parsedMessage.mediaUrls.length ? parsedMessage.mediaUrls : undefined,
    MediaType: parsedMessage.mediaTypes[0],
    MediaTypes: parsedMessage.mediaTypes.length ? parsedMessage.mediaTypes : undefined,
  });

  const storePath = core.channel.session.resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId,
  });
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: "napcat",
      to,
      accountId: route.accountId,
    },
    onRecordError: (err) => {
      params.log?.warn?.(`napcat: failed to record session: ${String(err)}`);
    },
  });

  params.statusSink?.({ lastInboundAt: Date.now() });

  const prefixContext = createReplyPrefixContext({ cfg: params.cfg, agentId: route.agentId });
  const textLimit = core.channel.text.resolveTextChunkLimit(params.cfg, "napcat", route.accountId, {
    fallbackLimit: params.account.textChunkLimit ?? DEFAULT_TEXT_LIMIT,
  });
  const chunkMode = core.channel.text.resolveChunkMode(params.cfg, "napcat", route.accountId);
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "napcat",
    accountId: route.accountId,
  });

  const sanitizeNapcatText = (text: string): string => {
    if (!text) return "";
    const withoutTables = core.channel.text.convertMarkdownTables(text, tableMode);
    const noMarkdown = stripMarkdown(withoutTables);
    // Napcat/QQ doesn't support HTML tags; strip any leftover tags.
    return noMarkdown.replace(/<[^>]+>/g, "");
  };

  const sendTextChunks = async (text: string) => {
    const chunks = core.channel.text.chunkTextWithMode(text, textLimit, chunkMode);
    const candidates = chunks.length > 0 ? chunks : [text];
    for (const chunk of candidates) {
      if (!chunk) continue;
      await sendNapcatText({
        cfg: params.cfg,
        accountId: route.accountId,
        to,
        text: sanitizeNapcatText(chunk),
      });
      params.statusSink?.({ lastOutboundAt: Date.now() });
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(params.cfg, route.agentId),
      deliver: async (payload: ReplyPayload) => {
        const mediaUrls =
          payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        const text = sanitizeNapcatText(payload.text ?? "");
        if (mediaUrls.length === 0) {
          await sendTextChunks(text);
          return;
        }

        let caption = text;
        if (caption && caption.length > textLimit) {
          await sendTextChunks(caption);
          caption = "";
        }

        let first = true;
        for (const mediaUrl of mediaUrls) {
          await sendNapcatMedia({
            cfg: params.cfg,
            accountId: route.accountId,
            to,
            text: first ? caption : "",
            mediaUrl,
          });
          params.statusSink?.({ lastOutboundAt: Date.now() });
          first = false;
        }
      },
      onError: (err, info) => {
        params.log?.warn?.(`napcat ${info.kind} reply failed: ${String(err)}`);
      },
    });

  await core.channel.reply.dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg: params.cfg,
    dispatcher,
    replyOptions,
  });

  markDispatchIdle();
}

export const napcatPlugin: ChannelPlugin<ResolvedNapcatAccount> = {
  id: "napcat",
  meta: {
    id: "napcat",
    label: "Napcat",
    selectionLabel: "Napcat (OneBot v11)",
    docsPath: "/channels/napcat",
    docsLabel: "napcat",
    blurb: "OneBot v11 via Napcat (private messages only).",
    order: 85,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
  },
  reload: { configPrefixes: ["channels.napcat"] },
  configSchema: buildChannelConfigSchema(NapcatConfigSchema),
  config: {
    listAccountIds: (cfg) => listNapcatAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveNapcatAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultNapcatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "napcat",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "napcat",
        accountId,
        clearBaseFields: ["wsUrl", "httpUrl", "accessToken", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
      httpUrl: account.httpUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveNapcatAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => normalizeAllowEntry(entry)),
  },
  pairing: {
    idLabel: "qq",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const accountId = resolveDefaultNapcatAccountId(cfg);
      await sendNapcatText({
        cfg,
        accountId,
        to: formatTarget(id),
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.napcat?.accounts?.[resolvedId]);
      const basePath = useAccountPath ? `channels.napcat.accounts.${resolvedId}.` : "channels.napcat.";
      return {
        policy: account.config.dmPolicy ?? "open",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint("napcat"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
  },
  messaging: {
    normalizeTarget: (target) => normalizeTarget(target),
    targetResolver: {
      looksLikeId: (input) => /^[0-9]+$/.test(input.trim()),
      hint: "<qq>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getNapcatRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    sendText: async ({ cfg, to, text, accountId }) => {
      const result = await sendNapcatText({ cfg, accountId, to, text });
      return { channel: "napcat", messageId: result.messageId, chatId: result.chatId };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      if (!mediaUrl) {
        throw new Error("Napcat mediaUrl missing");
      }
      const result = await sendNapcatMedia({ cfg, accountId, to, text, mediaUrl });
      return { channel: "napcat", messageId: result.messageId, chatId: result.chatId };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      wsUrl: account.wsUrl,
      httpUrl: account.httpUrl,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.wsUrl) {
        throw new Error("Napcat wsUrl not configured");
      }

      const updateStatus = (next: Partial<ChannelAccountSnapshot>) => {
        ctx.setStatus({
          ...ctx.getStatus(),
          ...next,
          accountId: account.accountId,
        });
      };

      updateStatus({
        running: true,
        connected: false,
        lastStartAt: Date.now(),
        lastError: null,
      });

      const connection = createOneBotConnection({
        wsUrl: account.wsUrl,
        httpUrl: account.httpUrl,
        accessToken: account.accessToken,
        log: ctx.log,
        onEvent: (event) => {
          void handlePrivateMessage({
            cfg: ctx.cfg,
            account,
            event,
            log: ctx.log,
            statusSink: updateStatus,
          }).catch((err) => {
            ctx.log?.warn?.(`napcat inbound error: ${String(err)}`);
          });
        },
        onConnected: () => {
          updateStatus({ connected: true, lastConnectedAt: Date.now(), lastError: null });
        },
        onDisconnected: () => {
          updateStatus({ connected: false, lastDisconnect: { at: Date.now() } });
        },
        onError: (err) => {
          updateStatus({ lastError: String(err) });
        },
      });

      activeConnections.set(account.accountId, connection);
      ctx.abortSignal.addEventListener(
        "abort",
        () => {
          connection.stop();
        },
        { once: true },
      );

      return {
        stop: () => {
          connection.stop();
          activeConnections.delete(account.accountId);
          updateStatus({ running: false, connected: false, lastStopAt: Date.now() });
        },
      };
    },
    stopAccount: async (ctx) => {
      const connection = activeConnections.get(ctx.accountId);
      if (connection) {
        connection.stop();
        activeConnections.delete(ctx.accountId);
      }
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },
  },
};
