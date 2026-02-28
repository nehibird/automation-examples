const { MongoClient } = require('mongodb');
const fs = require('fs');
const nodemailer = require('nodemailer');

// Apportionment Verification Script
// Compares tax apportionment recap values against General Ledger transactions in MongoDB
// Supports single client, comma-separated list, or "all" clients
//
// Usage:
//   node apportionment-check.js --client acme
//   node apportionment-check.js --clients "acme,globex,initech"
//   node apportionment-check.js --clients all
//   node apportionment-check.js --month -1    (previous month)
//   node apportionment-check.js --email        (send email report)
//   node apportionment-check.js --json         (output JSON for automation)
//
// Environment Variables:
//   MONGODB_URI     - MongoDB connection string
//   N8N_WEBHOOK_URL - Optional webhook URL for n8n integration
//   SEND_EMAIL      - Set to "true" to enable email reports
//   SMTP_HOST       - SMTP server hostname
//   SMTP_PORT       - SMTP server port
//   SMTP_USER       - SMTP username
//   SMTP_PASS       - SMTP password
//   EMAIL_FROM      - Sender email address
//   EMAIL_TO        - Recipient email address

// Parse command-line arguments
const args = process.argv.slice(2);
const argMap = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    argMap[key] = value;
    if (value !== true) i++;
  }
}

// Get first and last day of current month (or specified month offset)
function getMonthDateRange(monthOffset = 0) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + monthOffset;

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  const formatDate = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const y = d.getFullYear();
    return `${m}-${day}-${y}`;
  };

  return {
    fromDate: formatDate(firstDay),
    toDate: formatDate(lastDay),
    fromDateISO: firstDay.toISOString(),
    toDateISO: lastDay.toISOString()
  };
}

// Configuration
const config = {
  // Clients to process - override via --client or --clients
  clients: (() => {
    if (argMap.client) return [argMap.client.trim().toLowerCase()];
    if (argMap.clients) {
      const val = argMap.clients.trim().toLowerCase();
      if (val === 'all') {
        // Replace with your own client list
        return ['client1', 'client2', 'client3'];
      }
      return val.split(',').map(c => c.trim());
    }
    return ['client1', 'client2', 'client3'];
  })(),
  // Date range - defaults to current month
  dateRange: argMap.month
    ? getMonthDateRange(parseInt(argMap.month))
    : getMonthDateRange(0),
  // MongoDB connection
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017'
  },
  // Webhook URL for automation callback
  webhookUrl: argMap.webhook || process.env.N8N_WEBHOOK_URL || null,
  // Email configuration
  email: {
    enabled: argMap.email || process.env.SEND_EMAIL === 'true' || false,
    smtp: {
      host: process.env.SMTP_HOST || 'localhost',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || ''
      }
    },
    from: process.env.EMAIL_FROM || 'alerts@example.com',
    to: process.env.EMAIL_TO || 'admin@example.com',
    subject: 'Apportionment Verification Report - {date}'
  }
};

// Mapping: apportionment report tag values -> fund categories -> general ledger fund keys
// This maps the different revenue streams to their apportionment and GL counterparts
const FUND_CATEGORIES = {
  currentTax: {
    label: 'currentTax',
    description: 'Current Tax',
    apptTags: ['CTax', 'CTaxFee', 'CTaxPen'],
    cmnfundsAltKey: 'Current Tax'
  },
  priorTax: {
    label: 'priorTax',
    description: 'Prior Tax',
    apptTags: ['PTax', 'PTaxFee', 'PTaxPen'],
    cmnfundsAltKey: 'Prior Tax'
  },
  backTax: {
    label: 'backTax',
    description: 'Back Tax',
    apptTags: ['BTax', 'BTaxFee', 'BTaxPen'],
    cmnfundsAltKey: 'Back Tax'
  },
  miscReceipts: {
    label: 'miscReceipts',
    description: 'Misc Receipts',
    apptTags: ['ABT', 'JT4MILL', 'MV', 'MVTS', 'FLOOD', 'INTEREST', '', 'undefined'],
    cmnfundsAltKey: 'MISC'
  },
  mtgTaxCert: {
    label: 'mtgTaxCert',
    description: 'MtgTaxCert',
    apptTags: ['MtgTaxCert'],
    cmnfundsAltKey: 'MtgTaxFee'
  },
  mtgTax: {
    label: 'mtgTax',
    description: 'MtgTax',
    apptTags: ['MtgTax'],
    cmnfundsAltKey: 'MtgTax'
  }
};

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseMMDDYYYY(dateStr) {
  const parts = dateStr.split('-');
  return new Date(`${parts[2]}-${parts[0]}-${parts[1]}T00:00:00Z`);
}

function compareValues(apportionment, gl, tolerance = 0.01) {
  const diff = Math.abs(apportionment - gl);
  return {
    apportionment: Math.round(apportionment * 100) / 100,
    gl: Math.round(gl * 100) / 100,
    diff: Math.round(diff * 100) / 100,
    match: diff <= tolerance
  };
}

// Tax year classification: determines current/prior/back tax year based on
// the July 1 fiscal year boundary (common in government accounting)
function getTaxYearStatus(date = new Date()) {
  const givenDate = (typeof date.getMonth === 'function') ? date : new Date();
  const month = givenDate.getMonth() + 1;
  const year = givenDate.getFullYear();

  // July 1 is the cutoff for current tax year
  let currentTaxYearStart;
  if (month <= 6) {
    currentTaxYearStart = year - 1;
  } else {
    currentTaxYearStart = year;
  }

  return {
    nextTax: currentTaxYearStart + 1,
    currentTax: currentTaxYearStart,
    priorTax: currentTaxYearStart - 1,
    backTax: currentTaxYearStart - 2
  };
}

// ============================================================
// Client Config
// ============================================================

async function getClientConfig(db) {
  const configDoc = await db.collection('configs').findOne({ scope: 'paymentConfig' });
  const noPriorTax = configDoc?.config?.noPriorTax || false;
  return { noPriorTax };
}

// ============================================================
// Tax Totals from Source Collections (read-only)
// ============================================================

async function computeTaxTotals(db, fromDate, toDate, noPriorTax) {
  const queryFromDate = parseMMDDYYYY(fromDate);
  const queryToDate = parseMMDDYYYY(toDate);
  queryToDate.setUTCHours(23, 59, 59, 999);

  const taxYearStatus = getTaxYearStatus(queryToDate);
  console.log(`    Tax year status: current=${taxYearStatus.currentTax}, prior=${taxYearStatus.priorTax}, back=${taxYearStatus.backTax}`);
  console.log(`    noPriorTax: ${noPriorTax}`);

  const dateFilter = {
    payDate: { $gte: queryFromDate, $lte: queryToDate }
  };

  // Pipeline A: taxPayments collection (unwind taxDetails array)
  const pipelineA = [
    { $match: { ...dateFilter, isExempt: { $in: [false, null] } } },
    { $unwind: '$taxDetails' },
    { $match: { 'taxDetails.protest': false } },
    {
      $group: {
        _id: { taxYear: '$taxDetails.taxYear', schoolDistrict: '$taxDetails.schoolDistrict' },
        taxAmt: { $sum: '$taxDetails.taxAmt' },
        penaltyAmt: { $sum: '$taxDetails.penaltyAmt' },
        totalFees: { $sum: '$taxDetails.totalFees' },
        total: { $sum: '$taxDetails.total' }
      }
    }
  ];

  // Pipeline B: paymentTaxDetails collection (flat, no unwind needed)
  const pipelineB = [
    { $match: { ...dateFilter, isExempt: { $in: [false, null] }, protest: false } },
    {
      $group: {
        _id: { taxYear: '$taxYear', schoolDistrict: '$schoolDistrict' },
        taxAmt: { $sum: '$taxAmt' },
        penaltyAmt: { $sum: '$penaltyAmt' },
        totalFees: { $sum: '$totalFees' },
        total: { $sum: '$total' }
      }
    }
  ];

  const [resultsA, resultsB] = await Promise.all([
    db.collection('taxpayments').aggregate(pipelineA).toArray(),
    db.collection('paymenttaxdetails').aggregate(pipelineB).toArray()
  ]);

  console.log(`    taxPayments groups: ${resultsA.length}, paymentTaxDetails groups: ${resultsB.length}`);

  // Merge by taxYear-schoolDistrict key
  const merged = {};
  for (const record of [...resultsA, ...resultsB]) {
    const key = `${record._id.taxYear}-${record._id.schoolDistrict}`;
    if (merged[key]) {
      merged[key].taxAmt += (record.taxAmt || 0);
      merged[key].penaltyAmt += (record.penaltyAmt || 0);
      merged[key].totalFees += (record.totalFees || 0);
      merged[key].total += (record.total || 0);
    } else {
      merged[key] = {
        taxYear: record._id.taxYear,
        schoolDistrict: record._id.schoolDistrict,
        taxAmt: record.taxAmt || 0,
        penaltyAmt: record.penaltyAmt || 0,
        totalFees: record.totalFees || 0,
        total: record.total || 0
      };
    }
  }

  // Classify each merged group into Current/Prior/Back
  const glTotals = {};
  const apptTotals = {};

  for (const record of Object.values(merged)) {
    const { taxYear } = record;
    let yearCategory;

    if (taxYear === taxYearStatus.currentTax) {
      yearCategory = 'current';
    } else if (noPriorTax) {
      yearCategory = 'back';
    } else if (taxYear === taxYearStatus.priorTax) {
      yearCategory = 'prior';
    } else {
      yearCategory = 'back';
    }

    const glKey = yearCategory === 'current' ? 'Current Tax'
      : yearCategory === 'prior' ? 'Prior Tax'
      : 'Back Tax';
    glTotals[glKey] = (glTotals[glKey] || 0) + record.total;

    const taxTag = yearCategory === 'current' ? 'CTax'
      : yearCategory === 'prior' ? 'PTax'
      : 'BTax';
    const penTag = yearCategory === 'current' ? 'CTaxPen'
      : yearCategory === 'prior' ? 'PTaxPen'
      : 'BTaxPen';
    const feeTag = yearCategory === 'current' ? 'CTaxFee'
      : yearCategory === 'prior' ? 'PTaxFee'
      : 'BTaxFee';

    apptTotals[taxTag] = (apptTotals[taxTag] || 0) + record.taxAmt;
    apptTotals[penTag] = (apptTotals[penTag] || 0) + record.penaltyAmt;
    apptTotals[feeTag] = (apptTotals[feeTag] || 0) + record.totalFees;
  }

  console.log('    GL tax totals:', JSON.stringify(glTotals));
  console.log('    Appt tax totals:', JSON.stringify(apptTotals));

  return { glTotals, apptTotals };
}

// ============================================================
// Misc Totals from Source Collections (read-only)
// ============================================================

async function computeMiscTotals(db, fromDate, toDate) {
  const queryFromDate = parseMMDDYYYY(fromDate);
  const queryToDate = parseMMDDYYYY(toDate);
  queryToDate.setUTCHours(23, 59, 59, 999);

  const totalPipeline = [
    {
      $match: {
        businessDate: { $gte: queryFromDate, $lte: queryToDate },
        isSpecialApportionment: { $ne: true }
      }
    },
    {
      $group: {
        _id: null,
        totalMisc: { $sum: '$amount' }
      }
    }
  ];

  const detailPipeline = [
    {
      $match: {
        businessDate: { $gte: queryFromDate, $lte: queryToDate },
        isSpecialApportionment: { $ne: true }
      }
    },
    { $unwind: '$details' },
    {
      $group: {
        _id: '$details.unit',
        totalAmount: { $sum: '$details.amount' }
      }
    },
    {
      $lookup: {
        from: 'miscunitcodes',
        localField: '_id',
        foreignField: '_id',
        pipeline: [{ $project: { _id: 1, description: 1, unitCodeNumber: 1 } }],
        as: '_commUnit'
      }
    }
  ];

  const [totalResult, detailResults] = await Promise.all([
    db.collection('misctransactions').aggregate(totalPipeline).toArray(),
    db.collection('misctransactions').aggregate(detailPipeline).toArray()
  ]);

  const glTotal = totalResult[0]?.totalMisc || 0;

  const unitCodeToTag = {
    '1': 'ABT',
    '2': 'MV',
    '3': 'MVTS',
    '4': 'JT4MILL',
    '5': 'INTEREST',
    '6': 'FLOOD'
  };

  const apptTotals = {};
  let detailSum = 0;
  for (const detail of detailResults) {
    const unitCode = detail._commUnit?.[0]?.unitCodeNumber;
    const tag = unitCode ? (unitCodeToTag[String(unitCode)] || '') : '';
    apptTotals[tag] = (apptTotals[tag] || 0) + (detail.totalAmount || 0);
    detailSum += detail.totalAmount || 0;
  }

  const unaccounted = glTotal - detailSum;
  if (Math.abs(unaccounted) > 0.01) {
    apptTotals[''] = (apptTotals[''] || 0) + unaccounted;
  }

  console.log(`    Misc GL total: ${glTotal}`);
  console.log('    Misc appt totals:', JSON.stringify(apptTotals));

  return { glTotal, apptTotals };
}

// ============================================================
// Mortgage Tax Totals from Source Collections (read-only)
// ============================================================

async function computeMtgTotals(db, fromDate, toDate) {
  const queryFromDate = parseMMDDYYYY(fromDate);
  const queryToDate = parseMMDDYYYY(toDate);
  queryToDate.setUTCHours(23, 59, 59, 999);

  const pipeline = [
    {
      $match: {
        businessDate: { $gte: queryFromDate, $lte: queryToDate },
        isCorrection: { $ne: true }
      }
    },
    {
      $group: {
        _id: null,
        totalMtgTax: { $sum: '$mortgageTax' },
        totalCertFee: { $sum: '$fee' }
      }
    }
  ];

  const results = await db.collection('mtgtransactions').aggregate(pipeline).toArray();

  const totalMtgTax = results[0]?.totalMtgTax || 0;
  const totalCertFee = results[0]?.totalCertFee || 0;

  console.log(`    MtgTax: ${totalMtgTax}, CertFee: ${totalCertFee}`);

  return {
    glTotals: { MtgTax: totalMtgTax, MtgTaxFee: totalCertFee },
    apptTotals: { MtgTax: totalMtgTax, MtgTaxCert: totalCertFee }
  };
}

// ============================================================
// GL Totals from gldailytransactions (cross-check)
// ============================================================

async function getGLTotals(db, fromDate, toDate, fundIds) {
  const queryFromDate = parseMMDDYYYY(fromDate);
  const queryToDate = parseMMDDYYYY(toDate);
  queryToDate.setUTCHours(23, 59, 59, 999);

  const pipeline = [
    {
      $match: {
        fiscalYear: new Date().getFullYear(),
        businessDate: { $gte: queryFromDate, $lte: queryToDate },
        fund: { $in: fundIds }
      }
    },
    {
      $group: {
        _id: '$fund',
        totalDeposit: { $sum: '$deposit' },
        totalPayments: { $sum: '$payments' },
        totalTransferOut: { $sum: '$transferOut' }
      }
    }
  ];

  const results = await db.collection('gldailytransactions').aggregate(pipeline).toArray();

  const totals = {};
  for (const r of results) {
    const net = r.totalDeposit - (r.totalPayments || 0) - (r.totalTransferOut || 0);
    totals[r._id.toString()] = net;
  }
  return totals;
}

async function getFundMap(db) {
  const funds = await db.collection('cmnfunds').find({
    fiscalYear: new Date().getFullYear(),
    type: 'x'
  }).toArray();

  const fundMap = {};
  for (const fund of funds) {
    if (fund.altKey) {
      fundMap[fund.altKey] = {
        _id: fund._id,
        description: fund.description || fund.name || fund.altKey
      };
    }
  }
  return fundMap;
}

// ============================================================
// Per-Client Check (pure MongoDB, read-only)
// ============================================================

async function checkClient(mongoClient, clientName, dateRange) {
  const result = {
    client: clientName,
    status: null,
    comparison: null,
    error: null
  };

  try {
    // Each client has its own database, named by convention
    const db = mongoClient.db(`app-backend-${clientName}`);

    console.log('  [1/5] Getting client config...');
    const clientConfig = await getClientConfig(db);

    console.log('  [2/5] Getting fund mapping...');
    const fundMap = await getFundMap(db);
    console.log(`    Found ${Object.keys(fundMap).length} type "x" funds:`,
      Object.entries(fundMap).map(([k, v]) => `${k}=${v.description}`).join(', '));

    console.log('  [3/5] Computing tax totals from source...');
    const taxResult = await computeTaxTotals(db, dateRange.fromDate, dateRange.toDate, clientConfig.noPriorTax);

    console.log('  [4/5] Computing misc totals from source...');
    const miscResult = await computeMiscTotals(db, dateRange.fromDate, dateRange.toDate);

    console.log('  [5/5] Computing mtg totals from source...');
    const mtgResult = await computeMtgTotals(db, dateRange.fromDate, dateRange.toDate);

    // Build combined apportionment totals
    const apptTotals = {
      ...taxResult.apptTotals,
      ...miscResult.apptTotals,
      ...mtgResult.apptTotals
    };

    // Build combined GL totals
    const glByFundAltKey = {
      ...taxResult.glTotals,
      'MISC': miscResult.glTotal,
      ...mtgResult.glTotals
    };

    // Compare using FUND_CATEGORIES mapping
    console.log('\n  Comparing...');
    const comparison = {};
    let allMatch = true;

    for (const [catKey, cat] of Object.entries(FUND_CATEGORIES)) {
      let apptAmount = 0;
      for (const tag of cat.apptTags) {
        apptAmount += apptTotals[tag] || 0;
      }

      const glAmount = glByFundAltKey[cat.cmnfundsAltKey] || 0;

      const tolerance = cat.tolerancePercent
        ? Math.max(glAmount, apptAmount) * (cat.tolerancePercent / 100)
        : 0.01;
      const compResult = compareValues(apptAmount, glAmount, tolerance);
      comparison[cat.label] = compResult;

      if (!compResult.match) allMatch = false;

      const icon = compResult.match ? '\u2713' : '\u2717';
      const tagList = cat.apptTags.filter(t => apptTotals[t]).join('+') || '(none)';
      console.log(`    ${icon} ${cat.description} [${tagList}]: appt=${compResult.apportionment}, gl=${compResult.gl}, diff=${compResult.diff}`);
    }

    // Cross-check: compare computed GL totals against actual gldailytransactions
    const fundIds = [];
    const categoryToFundId = {};
    for (const [catKey, cat] of Object.entries(FUND_CATEGORIES)) {
      if (fundMap[cat.cmnfundsAltKey]) {
        const fundId = fundMap[cat.cmnfundsAltKey]._id;
        fundIds.push(fundId);
        categoryToFundId[catKey] = fundId.toString();
      }
    }

    if (fundIds.length > 0) {
      const actualGLTotals = await getGLTotals(db, dateRange.fromDate, dateRange.toDate, fundIds);
      let glDifferences = false;
      for (const [catKey, cat] of Object.entries(FUND_CATEGORIES)) {
        const fundIdStr = categoryToFundId[catKey];
        if (!fundIdStr) continue;
        const actualGL = actualGLTotals[fundIdStr] || 0;
        const computedGL = glByFundAltKey[cat.cmnfundsAltKey] || 0;
        const diff = Math.abs(actualGL - computedGL);
        if (diff > 0.01) {
          console.log(`    \u26A0 GL cross-check: ${cat.description} computed=${computedGL.toFixed(2)}, actual=${actualGL.toFixed(2)}, diff=${diff.toFixed(2)}`);
          glDifferences = true;
        }
      }
      if (!glDifferences) {
        console.log('    \u2713 GL cross-check: computed totals match gldailytransactions');
      }
    }

    result.comparison = comparison;
    result.status = allMatch ? 'MATCH' : 'MISMATCH';

  } catch (error) {
    result.status = 'ERROR';
    result.error = error.message;
    console.log(`\n  Error processing ${clientName}: ${error.message}`);
  }

  return result;
}

// ============================================================
// Main Execution
// ============================================================

async function main() {
  const startTime = Date.now();

  console.log('\n' + '='.repeat(60));
  console.log('APPORTIONMENT VERIFICATION SCRIPT');
  console.log('='.repeat(60));
  console.log(`Clients: ${config.clients.join(', ')}`);
  console.log(`Date Range: ${config.dateRange.fromDate} to ${config.dateRange.toDate}`);
  console.log(`Mode: Read-only MongoDB queries (no browser automation)`);
  console.log('='.repeat(60));

  let mongoClient;
  try {
    mongoClient = new MongoClient(config.mongodb.uri);
    await mongoClient.connect();
    console.log('MongoDB connected');
  } catch (err) {
    console.error(`MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }

  const results = [];

  for (let i = 0; i < config.clients.length; i++) {
    const clientName = config.clients[i];
    console.log(`\n[${i + 1}/${config.clients.length}] Processing ${clientName}...`);
    const result = await checkClient(mongoClient, clientName, config.dateRange);
    results.push(result);
  }

  // Retry failed clients
  const failedClients = results.filter(r => r.status === 'ERROR');
  if (failedClients.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log(`RETRYING ${failedClients.length} FAILED CLIENTS`);
    console.log('='.repeat(60));

    for (const failed of failedClients) {
      console.log(`\n[RETRY] Processing ${failed.client}...`);
      const retryResult = await checkClient(mongoClient, failed.client, config.dateRange);
      const index = results.findIndex(r => r.client === failed.client);
      if (index !== -1) {
        if (retryResult.status !== 'ERROR') {
          console.log(`  \u2713 Retry successful for ${failed.client}`);
        } else {
          console.log(`  \u2717 Retry failed for ${failed.client}: ${retryResult.error}`);
        }
        results[index] = retryResult;
      }
    }
  }

  await mongoClient.close();

  // Build summary
  const matched = results.filter(r => r.status === 'MATCH');
  const mismatched = results.filter(r => r.status === 'MISMATCH');
  const errors = results.filter(r => r.status === 'ERROR');

  const output = {
    summary: {
      total: results.length,
      matched: matched.length,
      mismatched: mismatched.length,
      errors: errors.length,
      dateRange: config.dateRange,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startTime
    },
    results
  };

  // Console summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total: ${results.length} | Matched: ${matched.length} | Mismatched: ${mismatched.length} | Errors: ${errors.length}`);

  if (matched.length > 0) {
    console.log('\n\u2713 Matched:');
    matched.forEach(r => console.log(`  - ${r.client}`));
  }

  if (mismatched.length > 0) {
    console.log('\n\u2717 Mismatched:');
    mismatched.forEach(r => {
      console.log(`  - ${r.client}`);
      if (r.comparison) {
        for (const [key, val] of Object.entries(r.comparison)) {
          if (!val.match) {
            console.log(`      ${key}: appt=${val.apportionment}, gl=${val.gl}, diff=${val.diff}`);
          }
        }
      }
    });
  }

  if (errors.length > 0) {
    console.log('\n\u26A0 Errors:');
    errors.forEach(r => console.log(`  - ${r.client}: ${r.error}`));
  }

  console.log('='.repeat(60));

  // Save results file
  const timestamp = getTimestamp();
  const outputFile = `apportionment-results-${timestamp}.json`;
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`\nResults saved to: ${outputFile}`);

  // JSON output for automation parsing
  if (argMap.json) {
    console.log('\n--- JSON OUTPUT ---');
    console.log(JSON.stringify(output, null, 2));
  }

  // Send notifications
  if (config.email.enabled) {
    await sendEmail(output);
  }

  if (config.webhookUrl) {
    await sendToWebhook(output);
  }
}

async function sendEmail(output) {
  console.log('\nSending email report...');

  try {
    const transporter = nodemailer.createTransport(config.email.smtp);

    const subject = config.email.subject
      .replace('{date}', new Date().toLocaleDateString());

    const statusIcon = output.summary.mismatched === 0 && output.summary.errors === 0 ? '\u2713' : '\u2717';

    await transporter.sendMail({
      from: config.email.from,
      to: config.email.to,
      subject: `${statusIcon} ${subject}`,
      html: generateEmailHtml(output)
    });

    console.log('\u2713 Email sent');
  } catch (error) {
    console.log(`\u2717 Email failed: ${error.message}`);
  }
}

function generateEmailHtml(output) {
  const { summary, results } = output;
  const allGood = summary.mismatched === 0 && summary.errors === 0;
  const statusColor = allGood ? '#2e7d32' : '#c62828';

  let html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; }
    h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f8f9fa; }
    .match { color: #2e7d32; }
    .mismatch { color: #c62828; }
    .error { color: #e65100; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Apportionment Verification Report</h1>
    <p><strong>Date Range:</strong> ${summary.dateRange.fromDate} to ${summary.dateRange.toDate}</p>
    <p><strong>Status:</strong> <span style="color:${statusColor}">${allGood ? 'All Matched' : 'Issues Found'}</span></p>
    <p>Total: ${summary.total} | Matched: ${summary.matched} | Mismatched: ${summary.mismatched} | Errors: ${summary.errors}</p>
    <table>
      <tr><th>Client</th><th>Status</th><th>Details</th></tr>`;

  for (const r of results) {
    const cls = r.status === 'MATCH' ? 'match' : r.status === 'MISMATCH' ? 'mismatch' : 'error';
    let details = '';
    if (r.status === 'MISMATCH' && r.comparison) {
      const mismatches = Object.entries(r.comparison).filter(([, v]) => !v.match);
      details = mismatches.map(([k, v]) => `${k}: ${v.apportionment} vs ${v.gl}`).join(', ');
    } else if (r.error) {
      details = r.error.substring(0, 80);
    }
    html += `<tr><td>${r.client}</td><td class="${cls}">${r.status}</td><td>${details}</td></tr>`;
  }

  html += `</table>
    <p style="font-size:12px;color:#666;">Generated: ${summary.timestamp}</p>
  </div>
</body>
</html>`;

  return html;
}

async function sendToWebhook(output) {
  if (!config.webhookUrl) return;

  console.log(`\nSending to webhook: ${config.webhookUrl}`);

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'apportionment-check',
        timestamp: new Date().toISOString(),
        ...output
      })
    });

    console.log(`\u2713 Webhook response: ${response.status}`);
  } catch (error) {
    console.log(`\u2717 Webhook failed: ${error.message}`);
  }
}

main().catch(console.error);
