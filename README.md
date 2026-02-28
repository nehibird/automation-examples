# Automation Examples

Real-world automation scripts I built for a software company that manages accounting systems for dozens of clients. These scripts replaced hours of manual work with automated verification and reporting.

## Scripts

### `eom-check.js` — End-of-Month Balance Verification

Uses [Playwright](https://playwright.dev/) to automate end-of-month balance checking across multi-tenant accounting web applications. Instead of a person logging into each client's system, clicking through screens, and copying results — this script does it all automatically.

**What it does:**
1. Launches a headless browser
2. Navigates to the client's posting period page
3. Handles authentication (workstation ID + credentials)
4. Clicks "Check End of Month Totals"
5. Extracts balance status and financial figures
6. Returns structured JSON results

**Usage:**
```bash
# Set credentials via environment variables
export APP_USERNAME="your_username"
export APP_PASSWORD="your_password"
export BASE_URL="https://{client}.yourapp.com"

node eom-check.js acme
```

**Output:**
```json
{
  "client": "acme",
  "status": "Balanced and OK to Close Month",
  "success": true,
  "data": {
    "currentPeriod": { "fromDate": "01-01-2026", "toDate": "01-31-2026" },
    "previousUncollectedTaxAmount": "1,234,567.89",
    "totalPayments": "456,789.12",
    "newUncollectedTaxAmount": "777,778.77"
  }
}
```

**Result:** What took a support person several hours every month-end now takes 5 minutes across all clients. [Read the full case study](https://birdherd.media/case/eom-automation)

---

### `apportionment-check.js` — Tax Apportionment vs GL Verification

Queries MongoDB directly to verify that tax apportionment recap values match General Ledger transactions. This catches discrepancies between what was collected (tax payments, misc receipts, mortgage tax) and what was posted to the general ledger.

**What it does:**
1. Connects to MongoDB
2. For each client, queries multiple collections (tax payments, misc transactions, mortgage transactions)
3. Classifies payments by tax year (current/prior/back) using fiscal year boundaries
4. Compares computed totals against GL daily transactions
5. Reports matches and mismatches with fund-level detail
6. Supports email reports and webhook notifications for automation

**Usage:**
```bash
# Set MongoDB connection string
export MONGODB_URI="mongodb+srv://user:pass@cluster.mongodb.net"

# Single client
node apportionment-check.js --client acme

# Multiple clients
node apportionment-check.js --clients "acme,globex,initech"

# All clients
node apportionment-check.js --clients all

# Previous month with email report
node apportionment-check.js --clients all --month -1 --email

# JSON output for automation
node apportionment-check.js --client acme --json
```

**Output:**
```
[1/1] Processing acme...
  [1/5] Getting client config...
  [2/5] Getting fund mapping...
  [3/5] Computing tax totals from source...
  [4/5] Computing misc totals from source...
  [5/5] Computing mtg totals from source...

  Comparing...
    ✓ Current Tax [CTax+CTaxPen+CTaxFee]: appt=234567.89, gl=234567.89, diff=0
    ✓ Prior Tax [PTax+PTaxPen+PTaxFee]: appt=12345.67, gl=12345.67, diff=0
    ✓ Back Tax [BTax+BTaxPen+BTaxFee]: appt=5678.90, gl=5678.90, diff=0
    ✓ Misc Receipts [ABT+MV+INTEREST]: appt=8901.23, gl=8901.23, diff=0

SUMMARY
Total: 1 | Matched: 1 | Mismatched: 0 | Errors: 0
```

**Result:** What took a team 40+ hours per month (manually comparing two screens, fund by fund, for every client) now takes 2 minutes. [Read the full case study](https://birdherd.media/case/slack-bot)

---

## How These Fit Together

In production, these scripts are triggered by a Slack bot. A support person types a command in Slack, and results are posted back to the channel automatically. The scripts run on a server via SSH, orchestrated by [n8n](https://n8n.io/) workflow automation.

## Tech Stack

- **Node.js** — Runtime
- **Playwright** — Browser automation (EOM check)
- **MongoDB** — Database queries (apportionment check)
- **Nodemailer** — Email reporting
- **n8n** — Workflow orchestration (not included here)
- **Slack API** — Chat interface (not included here)

## Environment Variables

| Variable | Description | Used By |
|----------|-------------|---------|
| `APP_USERNAME` | Web app login username | eom-check |
| `APP_PASSWORD` | Web app login password | eom-check |
| `BASE_URL` | URL pattern with `{client}` placeholder | eom-check |
| `WORKSTATION_ID` | Workstation identifier (default: "99") | eom-check |
| `MONGODB_URI` | MongoDB connection string | apportionment-check |
| `SMTP_HOST` | SMTP server hostname | apportionment-check |
| `SMTP_PORT` | SMTP server port | apportionment-check |
| `SMTP_USER` | SMTP username | apportionment-check |
| `SMTP_PASS` | SMTP password | apportionment-check |
| `EMAIL_FROM` | Sender email address | apportionment-check |
| `EMAIL_TO` | Recipient email address | apportionment-check |
| `N8N_WEBHOOK_URL` | Webhook URL for automation callbacks | apportionment-check |
| `SEND_EMAIL` | Set to "true" to enable email reports | apportionment-check |

## License

MIT
