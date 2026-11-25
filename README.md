# WhatsApp AI Seller

A WhatsApp sales bot with its own server. Customers chat with your WhatsApp number; **Claude** (Anthropic API) answers as a sales assistant: it looks up products, recommends, collects the order details, confirms, and places the order.

## How it works

```
WhatsApp customer ──► WhatsApp connector (Baileys or WAHA) ──► Express server ──► Claude (tool use)
                                                                                    ├─ search_products
                                                                                    ├─ create_order
                                                                                    └─ request_human
```

- `src/whatsapp/baileys.ts` – runs WhatsApp Web inside the Node process (scan a QR once; the session is saved in `auth/`).
- `src/whatsapp/waha.ts` – uses a [WAHA](https://waha.devlike.pro) container instead; WAHA posts messages to `/webhooks/waha`.
- `src/ai/seller.ts` – the seller: system prompt, tools, and per-chat conversation memory.
- `src/store/catalog.ts` – products from `data/products.json`, orders saved to `data/orders.json`.

Pick the connector with `WHATSAPP_PROVIDER=baileys|waha`.

## Setup

```bash
cp .env.example .env      # add your ANTHROPIC_API_KEY and store details
npm install
npm run dev
```

**Baileys:** a QR code appears in the logs. On the phone that owns the store number: WhatsApp → Settings → Linked devices → Link a device → scan.

**WAHA:** set `WHATSAPP_PROVIDER=waha`, then `docker compose --profile waha up`, open the WAHA dashboard on http://localhost:3001, start the `default` session and scan its QR.

Edit `data/products.json` with your catalog. Set `ADMIN_PHONE` to get new-order and handoff alerts on WhatsApp.

Customers can send `/reset` to start the conversation over.

## Production

```bash
docker compose up -d --build
```

Keep `auth/` (or `waha-sessions/`) on a persistent volume and never commit it: it is a logged-in WhatsApp session.

> ⚠️ Baileys and WAHA (WEBJS/NOWEB engines) use the unofficial WhatsApp Web protocol. That works, but WhatsApp may ban numbers that look like spam bots. Use a dedicated number, reply only to people who message you first, and avoid bulk messaging.

## Next steps

- Move conversations/orders to a database (SQLite/Postgres) — memory is in-process today and resets on restart.
- Handle images/voice notes (Claude can read images).
- Admin dashboard for orders and live takeover of chats.
