# Gratitude journal

Every morning at 09:00 (Israel time) WhatsApp asks, in Hebrew: *בוקר טוב ☀️ על אילו 3 דברים יש לך להודות היום?*
Reply in WhatsApp (one message with 3 lines, or 3 separate messages) and each item is saved.
Your journal lives at a private link you can add to your iPhone home screen.

Runs on Cloudflare Workers + D1 (free tier) and the official WhatsApp Cloud API.

## Setup

Do steps 1–5 on a computer; it takes about 30 minutes. Keep a note open to paste the values you collect.

### 1. Cloudflare database

1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com) (free plan).
2. Go to **Storage & Databases → D1 → Create database**, name it `gratitude-journal`.
3. Open the database, go to **Console**, paste the contents of [`schema.sql`](schema.sql) and run it.
4. Copy the **Database ID** and put it in `wrangler.toml` (or send it to Claude to commit).

### 2. Meta app and WhatsApp test number

1. Go to [developers.facebook.com](https://developers.facebook.com), log in with Facebook, and register as a developer.
2. **My Apps → Create app**. Choose the use case **Connect with customers through WhatsApp** (or type **Business**), and let it create a business portfolio.
3. Open **WhatsApp → API Setup**. Meta gives you a free test number.
   - Copy the **Phone number ID** → `WA_PHONE_NUMBER_ID`.
   - Under **To**, add your own WhatsApp number and enter the code Meta sends you.
   - Your number, digits only with country code (e.g. `972541234567`) → `MY_NUMBER`.
4. **App settings → Basic**: copy the **App secret** → `APP_SECRET`.

### 3. A token that doesn't expire

The token on the API Setup page dies after 24 hours, so make a permanent one:

1. Go to [business.facebook.com/settings](https://business.facebook.com/settings) → **Users → System users → Add**, role **Admin**.
2. **Assign assets**: your app (full control) and your WhatsApp account (full control).
3. **Generate token**: pick your app, expiration **Never**, permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Copy it → `WA_TOKEN`.

### 4. The morning message template

WhatsApp only lets an app start a conversation with an approved template.

1. In the Meta app, **WhatsApp → API Setup → Manage message templates** (opens WhatsApp Manager) → **Create template**.
2. Category **Marketing** (Meta reclassifies a Utility version and it can get stuck in review), name `gratitude_daily`, language **Hebrew**.
3. Body: `בוקר טוב ☀️ על אילו 3 דברים יש לך להודות היום?`
4. Submit. Approval is usually quick.

### 5. Deploy the Worker

1. In Cloudflare: **Workers & Pages → Create → Import a repository**, connect GitHub, pick this repo, and deploy. Every push to `main` redeploys.
2. In the Worker's **Settings → Variables and Secrets**, add these as **Secret**:

   | Name | Value |
   |---|---|
   | `WA_TOKEN` | from step 3 |
   | `WA_PHONE_NUMBER_ID` | from step 2 |
   | `APP_SECRET` | from step 2 |
   | `MY_NUMBER` | from step 2 |
   | `VERIFY_TOKEN` | any word you make up |
   | `JOURNAL_KEY` | a long random string (e.g. a generated password, letters and digits only); it's what keeps your journal private |

3. Note the Worker's URL, like `https://gratitude-journal.<you>.workers.dev`.

### 6. Connect WhatsApp replies to the Worker

1. In the Meta app, **WhatsApp → Configuration → Webhook → Edit**.
2. Callback URL: `https://<your-worker-url>/webhook`. Verify token: your `VERIFY_TOKEN`.
3. Under **Webhook fields**, subscribe to **messages**.

### 7. Try it

1. Open `https://<your-worker-url>/j/<JOURNAL_KEY>/send-now`. The morning message should arrive in WhatsApp.
2. Reply with your 3 things. You'll get a "נשמר" reply.
3. On your iPhone, open `https://<your-worker-url>/j/<JOURNAL_KEY>` in Safari → **Share → Add to Home Screen**.

## Pages

| URL | What |
|---|---|
| `/j/<JOURNAL_KEY>` | Journal, newest first, with search |
| `/j/<JOURNAL_KEY>/export.csv` | Everything as CSV |
| `/j/<JOURNAL_KEY>/send-now` | Send the morning message right now |

## Changing things

- **Time**: `SEND_HOUR` in `wrangler.toml`. The two crons there are 06:00 and 07:00 UTC, which cover 09:00 in Israel in summer and winter. For a different hour, shift both by the same amount.
- **Wording**: edit the template in WhatsApp Manager (or create a new one and change `TEMPLATE_NAME`).

## Running locally

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in values
npm run db:init:local
npm run dev                      # add --test-scheduled to trigger the cron at /__scheduled
```
