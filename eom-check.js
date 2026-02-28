#!/usr/bin/env node
// End-of-Month Balance Check - Single Client Mode
// Automates EOM balance verification for multi-tenant accounting web applications
// Usage: node eom-check.js <client>
// Returns JSON result with balance status and financial data
//
// This script uses Playwright to:
// 1. Navigate to a client's posting period page
// 2. Authenticate (workstation ID + credentials)
// 3. Click "Check End of Month Totals"
// 4. Extract balance status and financial figures
// 5. Return structured JSON results
//
// Environment Variables:
//   WORKSTATION_ID  - Workstation identifier (default: "99")
//   APP_USERNAME    - Login username
//   APP_PASSWORD    - Login password
//   BASE_URL        - Base URL pattern for client apps (e.g., "https://{client}.example.com")

const { chromium } = require("playwright");

const config = {
  workstationId: process.env.WORKSTATION_ID || "99",
  credentials: {
    username: process.env.APP_USERNAME || "",
    password: process.env.APP_PASSWORD || ""
  },
  baseUrl: process.env.BASE_URL || "https://{client}.example.com",
  navigationTimeout: 30000,
  actionTimeout: 10000
};

async function checkClientEOM(client) {
  const url = `${config.baseUrl.replace("{client}", client.toLowerCase().replace(/ /g, ""))}/tax/payments/utils/postingperiod`;
  const result = {
    client: client,
    url: url,
    timestamp: new Date().toISOString(),
    success: false,
    status: null,
    data: {
      currentPeriod: { fromDate: null, toDate: null },
      previousUncollectedTaxAmount: "0.00",
      totalAdjustments: "0.00",
      totalPayments: "0.00",
      newTaxRoll: "0.00",
      newUncollectedTaxAmount: "0.00",
      newPeriod: { fromDate: null, toDate: null }
    },
    error: null
  };

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--ignore-certificate-errors", "--no-sandbox", "--disable-dev-shm-usage"]
    });

    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    // Navigate to posting period page
    await page.goto(url, { timeout: config.navigationTimeout });

    // Check if we need to enter workstation ID
    const workstationDialog = await page.locator("text=Please Enter Workstation ID").isVisible({ timeout: 3000 }).catch(() => false);
    if (workstationDialog) {
      await page.locator("#workstationIdTextField").fill(config.workstationId);
      await page.getByRole("button", { name: "Save" }).click();
      await page.waitForTimeout(500);
    }

    // Check if we need to authenticate
    const authDialog = await page.locator("text=We need you to authenticate").isVisible({ timeout: 3000 }).catch(() => false);
    if (authDialog) {
      await page.getByRole("textbox", { name: "Login" }).fill(config.credentials.username);
      await page.getByRole("textbox", { name: "Password" }).fill(config.credentials.password);
      await page.getByRole("button", { name: "Sign-in" }).click();
      await page.waitForTimeout(1000);
    }

    // Wait for the main page to load
    await page.waitForSelector("text=Check End of Month Totals", { timeout: config.actionTimeout });

    // Click the Check End of Month Totals button
    await page.getByRole("button", { name: "Check End of Month Totals" }).click();

    // Wait for results to load (wait for either "Balanced and OK" or "Out of Balance")
    await page.waitForFunction(() => {
      const h2 = document.querySelector("h2");
      return h2 && (h2.textContent.includes("Balanced") || h2.textContent.includes("Out of Balance"));
    }, { timeout: config.actionTimeout });

    // Extract the status
    const statusElement = await page.locator("h2").first();
    result.status = (await statusElement.textContent()).trim();

    // Get values from the value paragraphs (they start with ": ")
    const valueElements = await page.locator("main").getByRole("paragraph").filter({ hasText: /^: / }).allTextContents();

    if (valueElements.length >= 5) {
      result.data.previousUncollectedTaxAmount = valueElements[0].replace(": ", "");
      result.data.totalAdjustments = valueElements[1].replace(": ", "");
      result.data.totalPayments = valueElements[2].replace(": ", "");
      result.data.newTaxRoll = valueElements[3].replace(": ", "");
      result.data.newUncollectedTaxAmount = valueElements[4].replace(": ", "");
    }

    // Extract date fields from inputs matching MM-DD-YYYY pattern
    const allInputs = await page.locator("input").all();
    const dateInputs = [];
    for (const input of allInputs) {
      const val = await input.inputValue().catch(() => "");
      if (val && /^\d{2}-\d{2}-\d{4}$/.test(val)) {
        dateInputs.push(val);
      }
    }
    if (dateInputs.length >= 4) {
      result.data.currentPeriod.fromDate = dateInputs[0];
      result.data.currentPeriod.toDate = dateInputs[1];
      result.data.newPeriod.fromDate = dateInputs[2];
      result.data.newPeriod.toDate = dateInputs[3];
    }

    result.success = true;
    await browser.close();
  } catch (err) {
    result.error = err.message;
    result.status = "Error";
    if (browser) await browser.close().catch(() => {});
  }

  return result;
}

async function main() {
  const client = process.argv[2];
  if (!client) {
    console.log(JSON.stringify({ error: "No client specified", usage: "node eom-check.js <client>" }));
    process.exit(1);
  }

  const result = await checkClientEOM(client);
  console.log(JSON.stringify(result));
}

main();
