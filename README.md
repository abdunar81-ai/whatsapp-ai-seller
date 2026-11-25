# WhatsApp AI Seller

A WhatsApp sales bot for **GLUCOSE** (ҰБТ prep courses) with its own server. Students write to the WhatsApp number; **Claude** (Anthropic API) answers as the sales manager, following the sales script in `data/script.md`: greets, asks name/subjects/grade, finds out their goals, presents the course and price, and closes on payment or a parent call. Every lead is saved to `data/leads.json`.

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
- `src/store/leads.ts` – the lead list (`data/leads.json`): name, grade, subjects, specialty, target score, parent phone, payment choice, stage.

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

Edit `data/script.md` to change the script or prices (it's mounted, so just restart the bot: `docker compose restart bot`). Set `KASPI_PAYMENT_LINK` so the bot can send the payment link, and `ADMIN_PHONE` to get alerts on WhatsApp when a lead is ready to pay, gives a parent's number, or needs a manager. Customers can send `/reset` to start over.

Both ports are bound to `127.0.0.1`, so nothing is exposed to the internet. Never commit `waha-sessions/` or `auth/`: they are a logged-in WhatsApp session.

## Automatic deploys (GitHub Actions)

Every push to `main` runs `.github/workflows/deploy.yml`: type-check and build, then upload the code to the server over SSH and run `docker compose up -d --build`. The server's `.env`, `waha-sessions/` and `data/leads.json` are never touched.

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
