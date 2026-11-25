# WhatsApp AI Seller

A WhatsApp sales bot for **GLUCOSE** (ҰБТ prep courses) with its own server. Students write to the WhatsApp number; **Claude** (Anthropic API) answers as the sales manager, following the sales script in `data/script.md`: greets, asks name/subjects/grade, finds out their goals, presents the course and price, and closes on payment or a parent call. Every lead and conversation is saved, and everything is managed from a web admin panel.

## How it works

```
WhatsApp customer ──► WhatsApp connector (Baileys or WAHA) ──► Express server ──► Claude (tool use)
                                                                                    ├─ save_lead
                                                                                    └─ request_human
```

- `src/whatsapp/waha.ts` – **default.** A [WAHA](https://waha.devlike.pro) container holds the WhatsApp session (NOWEB engine, no browser) and posts messages to `/webhooks/waha`.
- `src/whatsapp/baileys.ts` – alternative: runs WhatsApp Web inside the Node process (session saved in `auth/`).
- `data/script.md` – **the sales script and course facts** (Kazakh). Edit it to change what the bot says, then restart the bot.
- `src/ai/seller.ts` – the seller: instructions around the script, tools, and per-chat conversation memory.
- `src/store/*` + `src/db.ts` – SQLite database `data/bot.db`: chats and messages, leads, Claude usage/cost, settings.
- `src/admin/*` + `public/admin/` – the **admin panel**.

## Admin panel

`https://glucose.kzboard.online/admin` (set `DOMAIN`, `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`):

- **Overview** – messages, conversations, leads, funnel by stage, Claude cost (today / 7 / 30 days), 14-day chart.
- **Chats** – every conversation; take over a chat (pauses the bot there), write as the manager, reset the bot's memory.
- **Leads** – everything the bot collected, change stages, export CSV for Excel.
- **Bot tuning** – edit the sales script, reply depth (effort), Kaspi link, alert number; a **test chat** to try the bot without touching real customers.
- **WhatsApp** – connection status, **QR code** to link the store number, or a pairing code, unlink/restart.
- **Server** – uptime, CPU, memory, disk, live logs, restart the bot.
- The **Bot on** switch in the header stops all automatic replies at once.

Pick the connector with `WHATSAPP_PROVIDER=waha|baileys` (default `waha`).

## Run on the server (Docker + WAHA)

```bash
cp .env.example .env      # add ANTHROPIC_API_KEY, WAHA_API_KEY, store details
docker compose up -d --build
```

Link the WhatsApp number once:

1. Open `https://<DOMAIN>/admin` → **WhatsApp** → **Connect / show QR**.
2. Scan the QR from the store phone (WhatsApp → Settings → Linked devices → Link a device), or use the pairing code option.

The login is saved in `waha-sessions/`, so restarts don't need a new scan. Check the bot with `docker compose logs -f bot`.

Edit the script, payment link and alert number in the admin panel (**Bot tuning**). `data/` on the server holds the live script and the database; deploys never overwrite it. Customers can send `/reset` to start over.

Both ports are bound to `127.0.0.1`, so nothing is exposed to the internet. Never commit `waha-sessions/` or `auth/`: they are a logged-in WhatsApp session.

## Automatic deploys (GitHub Actions)

Every push to `main` runs `.github/workflows/deploy.yml`: type-check and build, then upload the code to the server over SSH and run `docker compose up -d --build`. The server's `.env`, `waha-sessions/` and `data/` (database + live script) are never touched.

One-time setup:

1. **Deploy key** (on your Mac):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/glucose_deploy -N "" -C "github-actions-deploy"
   ssh-copy-id -i ~/.ssh/glucose_deploy.pub USER@SERVER_IP
   ssh-keyscan SERVER_IP
   ```
2. **Server**: install Docker (`curl -fsSL https://get.docker.com | sudo sh`), then create `~/whatsapp-ai-seller/.env` from `.env.example`.
3. **GitHub repo secrets** (Settings → Secrets and variables → Actions):
   | Secret | Value |
   |---|---|
   | `SSH_HOST` | server IP |
   | `SSH_USER` | SSH user, e.g. `root` |
   | `SSH_PRIVATE_KEY` | contents of `~/.ssh/glucose_deploy` (the file **without** `.pub`) |
   | `SSH_KNOWN_HOSTS` | output of `ssh-keyscan SERVER_IP` |

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
