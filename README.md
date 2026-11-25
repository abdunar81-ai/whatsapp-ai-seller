# WhatsApp AI Seller

A WhatsApp sales bot with its own server. Customers chat with your WhatsApp number; **Claude** (Anthropic API) answers as a sales assistant: it looks up products, recommends, collects the order details, confirms, and places the order.

## How it works

```
WhatsApp customer ──► WhatsApp connector (Baileys or WAHA) ──► Express server ──► Claude (tool use)
                                                                                    ├─ search_products
                                                                                    ├─ create_order
                                                                                    └─ request_human
```

- `src/whatsapp/waha.ts` – **default.** A [WAHA](https://waha.devlike.pro) container holds the WhatsApp session (NOWEB engine, no browser) and posts messages to `/webhooks/waha`.
- `src/whatsapp/baileys.ts` – alternative: runs WhatsApp Web inside the Node process (session saved in `auth/`).
- `src/ai/seller.ts` – the seller: system prompt, tools, and per-chat conversation memory.
- `src/store/catalog.ts` – products from `data/products.json`, orders saved to `data/orders.json`.

Pick the connector with `WHATSAPP_PROVIDER=waha|baileys` (default `waha`).

## Run on the server (Docker + WAHA)

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY, WAHA_API_KEY, store details
docker compose up -d --build
```

Link the WhatsApp number once:

1. From your computer, open a tunnel to the server: `ssh -L 3001:localhost:3001 user@your-server`
2. Open http://localhost:3001/dashboard, enter your `WAHA_API_KEY`.
3. Start the `default` session and scan the QR from the store phone (WhatsApp → Settings → Linked devices → Link a device).

The login is saved in `waha-sessions/`, so restarts don't need a new scan. Check the bot with `docker compose logs -f bot`.

Edit `data/products.json` with your catalog (it's mounted, so just restart the bot: `docker compose restart bot`). Set `ADMIN_PHONE` to get new-order and handoff alerts on WhatsApp. Customers can send `/reset` to start over.

Both ports are bound to `127.0.0.1`, so nothing is exposed to the internet. Never commit `waha-sessions/` or `auth/`: they are a logged-in WhatsApp session.

## Local development

```bash
docker compose up -d waha   # WAHA only; set its webhook to your machine or run the bot in Docker too
npm install
npm run dev
```

> ⚠️ WAHA and Baileys use the unofficial WhatsApp Web protocol. WhatsApp may ban numbers that look like spam bots. Use a dedicated number, reply only to people who message you first, and avoid bulk messaging.

## Next steps

- Move conversations/orders to a database (SQLite/Postgres) — memory is in-process today and resets on restart.
- Handle images/voice notes (Claude can read images).
- Admin dashboard for orders and live takeover of chats.
