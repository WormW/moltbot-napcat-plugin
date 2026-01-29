import WebSocket from "ws";

type OneBotActionRequest = {
  action: string;
  params?: Record<string, unknown>;
  echo?: string;
};

export type OneBotActionResponse = {
  status: "ok" | "async" | "failed";
  retcode: number;
  data?: Record<string, unknown> | null;
  echo?: string;
};

export type OneBotEventPayload = Record<string, unknown> & {
  post_type?: string;
};

type ConnectionLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export type OneBotConnection = {
  sendAction: (action: string, params?: Record<string, unknown>) => Promise<OneBotActionResponse>;
  stop: () => void;
  isConnected: () => boolean;
};

type OneBotConnectionOptions = {
  wsUrl: string;
  httpUrl?: string;
  accessToken?: string;
  log?: ConnectionLog;
  onEvent: (event: OneBotEventPayload) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: unknown) => void;
};

const REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

function appendAccessToken(url: string, accessToken?: string): string {
  if (!accessToken) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("access_token")) {
      parsed.searchParams.set("access_token", accessToken);
    }
    return parsed.toString();
  } catch {
    return url;
  }
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

function isEventPayload(payload: unknown): payload is OneBotEventPayload {
  return Boolean(payload && typeof payload === "object" && "post_type" in payload);
}

export function createOneBotConnection(opts: OneBotConnectionOptions): OneBotConnection {
  const pending = new Map<
    string,
    {
      resolve: (value: OneBotActionResponse) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  let ws: WebSocket | null = null;
  let stopped = false;
  let echoCounter = 0;
  let reconnectAttempts = 0;

  const isConnected = () => ws?.readyState === WebSocket.OPEN;

  const cleanupPending = (reason: string) => {
    for (const [echo, entry] of pending.entries()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error(reason));
      pending.delete(echo);
    }
  };

  const connect = () => {
    if (stopped) return;
    const url = appendAccessToken(opts.wsUrl, opts.accessToken);
    ws = new WebSocket(url);

    ws.on("open", () => {
      reconnectAttempts = 0;
      opts.onConnected?.();
    });

    ws.on("message", (data) => {
      let payload: unknown;
      try {
        const text = typeof data === "string" ? data : data.toString();
        payload = JSON.parse(text);
      } catch (err) {
        opts.log?.warn?.(`napcat: failed to parse websocket payload: ${String(err)}`);
        return;
      }

      if (isEventPayload(payload)) {
        opts.onEvent(payload);
        return;
      }

      if (payload && typeof payload === "object" && "echo" in payload) {
        const echo = String((payload as OneBotActionResponse).echo ?? "");
        const pendingEntry = pending.get(echo);
        if (!pendingEntry) return;
        clearTimeout(pendingEntry.timeout);
        pending.delete(echo);
        pendingEntry.resolve(payload as OneBotActionResponse);
      }
    });

    ws.on("error", (err) => {
      opts.onError?.(err);
    });

    ws.on("close", () => {
      ws = null;
      opts.onDisconnected?.();
      cleanupPending("WebSocket closed");
      if (stopped) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
      reconnectAttempts += 1;
      setTimeout(connect, delay);
    });
  };

  const sendActionWs = async (
    action: string,
    params?: Record<string, unknown>,
  ): Promise<OneBotActionResponse> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const echo = String((echoCounter += 1));
    const payload: OneBotActionRequest = { action, params, echo };
    const result = new Promise<OneBotActionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`OneBot request timeout: ${action}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(echo, { resolve, reject, timeout });
    });

    ws.send(JSON.stringify(payload));
    return result;
  };

  const sendActionHttp = async (
    action: string,
    params?: Record<string, unknown>,
  ): Promise<OneBotActionResponse> => {
    if (!opts.httpUrl) {
      throw new Error("HTTP fallback not configured");
    }
    const url = buildHttpUrl(opts.httpUrl, action, opts.accessToken);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params ? JSON.stringify(params) : "{}",
    });
    if (!response.ok) {
      throw new Error(`OneBot HTTP error (${action}): ${response.status}`);
    }
    return (await response.json()) as OneBotActionResponse;
  };

  const sendAction = async (
    action: string,
    params?: Record<string, unknown>,
  ): Promise<OneBotActionResponse> => {
    if (isConnected()) {
      try {
        return await sendActionWs(action, params);
      } catch (err) {
        opts.log?.warn?.(`napcat: ws send failed (${action}), falling back to HTTP`);
        if (opts.httpUrl) return await sendActionHttp(action, params);
        throw err;
      }
    }
    return await sendActionHttp(action, params);
  };

  connect();

  return {
    sendAction,
    stop: () => {
      stopped = true;
      cleanupPending("WebSocket stopped");
      ws?.close();
      ws = null;
    },
    isConnected,
  };
}
