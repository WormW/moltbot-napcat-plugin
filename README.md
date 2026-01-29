# Napcat OneBot v11 plugin for Moltbot

Status: 功能未调试测试 (untested).

## Features
- OneBot v11 forward WebSocket (`/`) for inbound events and API calls.
- HTTP fallback for outbound actions.
- Private messages only.
- Media support for image/audio/video via OneBot message segments.

## Install
- Local dev: `moltbot plugins install -l .`
- From npm (if published): `moltbot plugins install @moltbot/napcat`

## Configuration
```json
{
  "channels": {
    "napcat": {
      "dmPolicy": "open",
      "accounts": {
        "default": {
          "wsUrl": "ws://127.0.0.1:6700/?access_token=YOUR_TOKEN",
          "httpUrl": "http://127.0.0.1:5700",
          "accessToken": "YOUR_TOKEN"
        }
      }
    }
  }
}
```

## Notes
- Only private messages (`message_type=private`) are handled.
- For production, switch to `dmPolicy: "pairing"` and configure `allowFrom`.
