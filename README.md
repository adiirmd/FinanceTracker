# FinanceTracker

Personal finance tracker that records spending from the push notifications banking
and digital wallet apps already send. Notifications are forwarded from a phone to a
webhook, parsed into transactions, and written to Google Sheets. Telegram delivers
spending alerts and scheduled recaps.

There is no database. Google Sheets is the datastore, which keeps the running cost
at zero and leaves the data in a form that can be read, filtered and corrected by
hand without going through the application.

Live instance: [finance.adiirmd.my.id](https://finance.adiirmd.my.id)

## How it works

```
Push notification (MyBCA, GoPay, DANA, OVO, ShopeePay, ...)
      |
      |  POST /api/webhook        headers: x-webhook-secret, x-source-app
      v
  lib/parser.js                   extracts amount and direction
      |
      v
  Google Sheets                   one tab per billing cycle, e.g. "September-2026"
      |
      +--> lib/alerts.js          Telegram alert per Rp50.000 of daily spending
      +--> GET /api/recap         daily and monthly recap to Telegram
      +--> Dashboard              browse, add, edit, delete, export to PDF
```

Transactions can also be entered by hand from the dashboard, with an optional
backdate for anything recorded late.

## Parsing

The parser is deliberately source agnostic. Instead of one handwritten pattern per
application, it looks for two things in the notification text: a currency amount
(`Rp50.000` or `IDR 18,000.00`) and an Indonesian keyword that indicates direction,
such as `pembayaran` or `terkirim` for an expense and `diterima` or `top up` for
income. A new application is usually picked up without a code change.

Notifications that cannot be parsed are answered with `200 OK` and
`{"stored": false}` rather than an error, so the forwarding app on the phone treats
them as delivered instead of retrying indefinitely. Unparsed text is logged for
review.

## Billing cycle

Periods follow a salary cycle rather than the calendar month: a cycle runs from the
28th to the 27th of the following month. Transactions from 28 August to
27 September belong to the `September-2026` tab. All timestamps are stored and
displayed in WIB (UTC+7) regardless of where the request originates.

## Spreadsheet layout

Each cycle gets its own tab, created and formatted automatically when the first
transaction of that cycle arrives.

| Columns | Block         | Fields                                       |
| ------- | ------------- | -------------------------------------------- |
| B:E     | Pengeluaran   | date, amount, application, notification text |
| G:J     | Pemasukan     | date, amount, application, notification text |
| L:N     | Rekap Harian  | date, expense total, income total            |
| P:Q     | Rekap Bulanan | cycle expense total, cycle income total      |

Rows are kept in chronological order. A backdated entry is inserted at the position
its timestamp belongs to, shifting later rows down within its own columns, rather
than being appended to the first free row.

Recap blocks are written as plain values rather than formulas and recomputed after
every change, so the figures can be verified independently of spreadsheet formula
behaviour. Column S holds two bookkeeping cells that record when each recap was
last sent.

## Project structure

```
api/
  webhook.js            POST    receive a notification, parse it, store it
  login.js              POST    authenticate and issue a JWT
  recap.js              GET     send the daily or monthly recap to Telegram
  transactions/
    index.js            GET     list transactions and available cycles
                        POST    create a transaction
    [id].js             PUT     update a transaction
                        DELETE  remove a transaction
lib/
  sheets.js             Google Sheets access: layout, reads, writes, recap
  parser.js             notification text to transaction
  format.js             WIB date handling, cycle naming, currency formatting
  alerts.js             threshold alerts for daily spending
  telegram.js           Telegram Bot API client
  auth.js               JWT issuing and verification
  secure.js             constant time comparison, input sanitising, amount validation
  retry.js              exponential backoff for transient API failures
public/                 dashboard (vanilla HTML, CSS and JavaScript)
vercel.json             security headers
```

## Configuration

All configuration is by environment variable. Nothing is committed to the
repository.

| Variable                       | Purpose                                        |
| ------------------------------ | ---------------------------------------------- |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account with edit access to the sheet  |
| `GOOGLE_PRIVATE_KEY`           | Service account private key (`\n` is accepted) |
| `GOOGLE_SHEET_ID`              | Target spreadsheet ID                          |
| `TELEGRAM_BOT_TOKEN`           | Bot token for alerts and recaps                |
| `TELEGRAM_CHAT_ID`             | Destination chat                               |
| `ADMIN_USER`                   | Dashboard username                             |
| `ADMIN_PASS`                   | Dashboard password                             |
| `JWT_SECRET`                   | Signing key, 32 characters or longer           |
| `WEBHOOK_SECRET`               | Shared secret required by the webhook          |
| `CRON_SECRET`                  | Shared secret required by the recap endpoint   |

## Deployment

1. Create a Google Cloud service account, enable the Google Sheets API and
   download its key. Share the target spreadsheet with the service account email,
   granting Editor access.
2. Create a Telegram bot through [@BotFather](https://t.me/BotFather) and note the
   token and destination chat ID.
3. Set the environment variables above in the Vercel project and deploy. Cycle tabs
   are created on demand, so no spreadsheet preparation is required.
4. Configure a notification forwarder on the phone (Tasker, MacroDroid or Automate)
   to POST notification text to `/api/webhook`.
5. Schedule the recaps from an external scheduler, sending
   `Authorization: Bearer <CRON_SECRET>`:
   - `GET /api/recap?period=daily` shortly before midnight WIB
   - `GET /api/recap?period=monthly` at the end of the cycle, on the 27th

   Recaps are idempotent within a one hour window, so an overlapping scheduler or a
   retry will not send the same summary twice.

## API

Submit a notification:

```bash
curl -X POST https://finance.adiirmd.my.id/api/webhook \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -H "x-source-app: gopay" \
  -H "Content-Type: application/json" \
  -d '{"text":"Pembayaran Rp25.000 berhasil"}'
```

Authenticate and read the ledger:

```bash
TOKEN=$(curl -s -X POST https://finance.adiirmd.my.id/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"...","password":"..."}' | jq -r .token)

curl https://finance.adiirmd.my.id/api/transactions \
  -H "Authorization: Bearer $TOKEN"
```

## Spending alerts

Every Rp50.000 threshold that a transaction pushes the day's spending past produces
a Telegram message, in ascending order, so a single large expense that takes the
total from zero past Rp100.000 reports both crossings. From Rp150.000 upwards the
message switches to capitals.

Because there is no database to remember which thresholds have already fired, the
crossing is derived: the day's total after the transaction, minus the transaction
itself, gives the total before it, and the brackets in between are the ones that
need reporting. Backdated entries never alert. They are bookkeeping, and announcing
today's running total for a day that has already ended would be both wrong and
noisy.

## Security

- Dashboard access is protected by a JWT signed with HS256 and pinned to that
  algorithm, valid for one hour. The token is held in a JavaScript variable only,
  never in a cookie, `localStorage` or `sessionStorage`, so any reload ends the
  session.
- Secrets (password, webhook secret, cron secret) are compared in constant time
  after hashing, so neither their contents nor their length leak through response
  timing.
- The login endpoint limits attempts to 8 per 15 minutes per address and holds every
  response to the same minimum duration, so a rejected password, an unknown user
  and a request that hit the limit are indistinguishable.
- Transaction identifiers are validated against a fixed pattern before use, so a
  forged identifier cannot be aimed at an arbitrary cell or another tab.
- Stored text is stripped of control characters and capped in length. Amounts are
  rejected unless finite, positive and within a sane range.
- Responses carry a strict Content Security Policy, HSTS and the usual hardening
  headers. Chart.js and jsPDF are vendored into `public/vendor/` so the dashboard
  loads no external scripts at runtime.

## Local development

```bash
npm install
npm run dev
```

`npm run dev` runs `vercel dev`. Provide the environment variables in a local `.env`
file, which is excluded from version control.
