const cheerio = require("cheerio");
/*{ok: true,
    providerKey: "telebirr",
    resolvedUrl: "https://transactioninfo.ethiotelecom.et/receipt/CJF7HITHQF",
    httpStatus: 200,
    fetchedAt: "2026-09-06T09:40:07.363Z",
    receipt: 
    {
        source: "telebirr-html",
        payerName: "BEKELE GARED GEBRE HIWOT",
        receiptNo: "CJF7HITHQF",
        serviceFee: "7.83 Birr",
        paymentDate: "15-10-2025 15:26:23",
        paymentMode: "telebirr",
        paymentReason: "Customer Transfer from Mobile Money to Bank",
        serviceFeeVAT: "1.17 Birr",
        settledAmount: "2,500 Birr",
        paymentChannel: "API/App",
        payerTelebirrNo: "2519****7808",
        totalPaidAmount: "2,509 Birr",
        payerAccountType: "Individual Customer",
        bankAccountNumber: "1000277825078   BEMERI MISRAKE TSEHAY MEKANE KIDIST",
        creditedPartyName: "Commercial Bank of Ethiopia",
        transactionStatus: "Completed",
        creditedPartyAccountNo: "0003"
    },
    rawHtmlLength: 27445,
    egressSource: null,
    error: null,
    cached: true
}*/

// ─────────────────────────────────────────────
// Transaction (receipt) number from what the customer pasted.
// Handles all of these for telebirr:
//   1. the full SMS  ("... Your transaction number is DJ56G0WKVM. ...")
//   2. the full SMS that also contains the receipt link (".../receipt/DJ92KW2GFW.")
//   3. just the link  "https://transactioninfo.ethiotelecom.et/receipt/DJ92KW2GFW"
//   4. a markdown link "[DJ92KW2GFW](https://transactioninfo.ethiotelecom.et/receipt/DJ92KW2GFW)"
//   5. just the number "DJ92KW2GFW"
// If the text contains two different numbers (for example the number in the sentence and a
// different one in the link) it is refused (returns null) instead of guessing.
// ─────────────────────────────────────────────
const RECEIPT_URL_BASE = {
  "telebirr": "transactioninfo\\.ethiotelecom\\.et",
  "m-pesa": "m-pesabusiness\\.safaricom\\.et"
};
const RECEIPT_ID_RE = /^[A-Z0-9]{8,14}$/;

function parseReceiptNumber(typeName, text) {
  const type = String(typeName || "").toLowerCase();
  const host = RECEIPT_URL_BASE[type];
  if (!host || typeof text !== "string") return null;

  // invisible characters, non-breaking spaces and surrounding whitespace
  const t = text.replace(/[​-‍﻿]/g, "").replace(/ /g, " ").trim();
  if (!t) return null;

  const found = new Set();

  // (2)(3)(4) a receipt link anywhere in the text; the id ends at the first character that is not a letter/digit
  const urlRe = new RegExp("https?:\\/\\/" + host + "\\/receipt\\/([A-Za-z0-9]+)", "gi");
  for (const m of t.matchAll(urlRe)) found.add(m[1].toUpperCase());

  // (1) "Your transaction number is XXXXXXXXXX"  (also "transaction no", "transaction id", "receipt no")
  const phraseRe = /(?:transaction|receipt)\s*(?:number|no\.?|id)\s*(?:is|:|-)?\s*([A-Za-z0-9]{8,14})(?![A-Za-z0-9])/gi;
  for (const m of t.matchAll(phraseRe)) found.add(m[1].toUpperCase());

  // (5)(4) nothing found yet: the text is only the number, optionally in [ ] or ( ) or quotes
  if (found.size === 0) {
    const bare = t.replace(/^[\s\[\]\(\)"'`<>*_]+|[\s\[\]\(\)"'`<>*_.,;:]+$/g, "");
    if (RECEIPT_ID_RE.test(bare.toUpperCase())) found.add(bare.toUpperCase());
  }

  const ids = [...found].filter(id => RECEIPT_ID_RE.test(id));
  if (ids.length !== 1) return null;      // none, or two different numbers
  return ids[0];
}

async function extractInvoiceNumber(typeName, sms) 
{
  const invoiceNo = parseReceiptNumber(typeName, sms);
  console.log("Invoice No:", invoiceNo);
  return invoiceNo;
}

async function builURLfromInvoiceNo(typeName, invoiceNo) 
{
  let url = "";
  if(typeName.toLowerCase() === "telebirr")
  {
    url = `https://transactioninfo.ethiotelecom.et/receipt/${invoiceNo}`;
  }
  else if(typeName.toLowerCase() === "m-pesa")
  {
    url = `https://m-pesabusiness.safaricom.et/receipt/${invoiceNo}`;
  }
  else 
  {
    url = "";
  }
  console.log("Receipt URL:", url);
  return url;
}


async function checkUrl(url) {
  
try {
    const { response, error } = await fetchWithRetry(url);
    if (!response) throw error || new Error("No response");

    if (!response.ok) {
      console.log(`Invalid URL. HTTP status: ${response.status}`);
      return false;
    }

    console.log("URL is valid.");
    return true;

  } catch (error) {
    console.log("URL is invalid:", error.message);
    return false;
  }
}


async function extractTransactionInfo(url) {
  try {
    const { response, error } = await fetchWithRetry(url);
    if (!response) throw error || new Error("No response");

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const result = {
      invoiceNo: null,
      payerName: null,
      payerTelebirrNo: null,
      creditedPartyName: null,
      creditedPartyAccountNo: null,
      paymentDate: null,
      amount: null
    };

    $("tr").each((index, row) => {

      const cells = $(row)
        .find("td")
        .map((i, cell) =>
          $(cell)
            .text()
            .replace(/\s+/g, " ")
            .trim()
        )
        .get();

      if (cells.length < 2) return;

      const label = cells[0].toLowerCase();
      const value = cells[1];

      // Invoice No.
      if (
        cells.some(cell =>
          cell.toLowerCase().includes("invoice no")
        )
      ) {
        const invoiceIndex = cells.findIndex(cell =>
          cell.toLowerCase().includes("invoice no")
        );

        const nextRow = $(row).next("tr");

        result.invoiceNo = nextRow
          .find("td")
          .eq(invoiceIndex)
          .text()
          .replace(/\s+/g, " ")
          .trim();
      }

      // Payer Name
      if (label.includes("payer name")) {
        result.payerName = value;
      }

      // Payer Telebirr No.
      if (label.includes("payer telebirr")) {
        result.payerTelebirrNo = value;
      }

      // Credited Party Name
      if (label.includes("credited party name")) {
        result.creditedPartyName = value;
      }

      // Credited Party Account No.
      if (label.includes("credited party account")) {
        result.creditedPartyAccountNo = value;
      }

      // Payment Date
      if (
        cells.some(cell =>
          cell.toLowerCase().includes("payment date")
        )
      ) {
        const paymentDateIndex = cells.findIndex(cell =>
          cell.toLowerCase().includes("payment date")
        );

        const nextRow = $(row).next("tr");

        result.paymentDate = nextRow
          .find("td")
          .eq(paymentDateIndex)
          .text()
          .replace(/\s+/g, " ")
          .trim();
      }

      // Settled Amount
      if (
        cells.some(cell =>
          cell.toLowerCase().includes("settled amount")
        )
      ) {
        const amountIndex = cells.findIndex(cell =>
          cell.toLowerCase().includes("settled amount")
        );

        const nextRow = $(row).next("tr");

        result.amount = nextRow
          .find("td")
          .eq(amountIndex)
          .text()
          .replace(/\s+/g, " ")
          .trim();
      }
    });

    return result;

  } catch (error) {
    console.error("Extraction Error:", error.message);
    return null;
  }
}

// 502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout (and 429) are temporary:
// try again a few times with a short pause before telling the customer.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options = {}, { attempts = 3, baseDelayMs = 1000, timeoutMs = 10000 } = {}) {
  let lastResponse = null;
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!RETRY_STATUSES.has(response.status)) return { response, error: null, attempts: i };
      lastResponse = response;
      lastError = null;
      console.warn(`HTTP ${response.status} from ${new URL(url).host} (attempt ${i}/${attempts})`);
      try { await response.arrayBuffer(); } catch (e) {}       // free the connection
    } catch (error) {
      lastResponse = null;
      lastError = error;
      console.warn(`${error.name === "AbortError" ? "Timeout" : "Network error: " + error.message} calling ${new URL(url).host} (attempt ${i}/${attempts})`);
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts) await sleep(baseDelayMs * i);              // 1 s, 2 s, ...
  }
  return { response: lastResponse, error: lastError, attempts };
}

async function extractTransactionInfofromThirdParty(typeName, receiptId) {
  const url =
    `https://checkit.et/api/process.php?type=${encodeURIComponent(
      typeName.toLowerCase()
    )}&receiptid=${encodeURIComponent(receiptId)}`;

  const { response, error, attempts } = await fetchWithRetry(
    url,
    { headers: { Accept: "application/json" } },
    { attempts: 3, baseDelayMs: 1000, timeoutMs: 10000 }
  );

  // no answer at all
  if (!response) {
    if (error && error.name === "AbortError") {
      console.error(`Checkit API timed out (${attempts} attempts)`);
      return { ok: false, timeout: true, unavailable: false, error: "Checkit timeout" };
    }
    console.error("Checkit API request failed:", error && error.message);
    return { ok: false, timeout: false, unavailable: true, error: error ? error.message : "No response" };
  }

  // still 502 / 503 / 504 / 429 after the retries: the service is down, not a wrong number
  if (RETRY_STATUSES.has(response.status)) {
    console.error(`Checkit still returns HTTP ${response.status} after ${attempts} attempts`);
    return { ok: false, timeout: false, unavailable: true, status: response.status, error: `HTTP ${response.status}` };
  }

  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    const body = await response.text();
    console.error(`Checkit HTTP ${response.status}:`, body.slice(0, 500));
    return { ok: false, timeout: false, unavailable: false, status: response.status, error: `HTTP ${response.status}` };
  }

  if (!contentType.includes("application/json")) {
    // an HTML error page from a gateway that answered 200
    const body = await response.text();
    console.error("Checkit returned non-JSON response:", body.slice(0, 500));
    return { ok: false, timeout: false, unavailable: /bad gateway|service unavailable|gateway time-?out/i.test(body), error: "Non-JSON response" };
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    console.error("Checkit returned invalid JSON:", e.message);
    return { ok: false, timeout: false, unavailable: false, error: "Invalid JSON" };
  }

  if (!data.ok) {
    console.log("Checkit API error:", data);
    return { ok: false, timeout: false, unavailable: false, error: "Checkit API returned ok=false", data };
  }

  return { ok: true, timeout: false, unavailable: false, data };
}
// ─────────────────────────────────────────────
// MAIN DEPOSIT PROCESS
// ─────────────────────────────────────────────

async function processDeposit(sms, pmName, pmAmharicName, ptName, ptAmharicName) 
{ 
  let invoiceNo = "";
  let result = null;
  if(sms.length < 10)
  {
    console.log("SMS or InvoiceNo length is lessthan 10.");
    return {result,success:false,errorMessage:"SMS or InvoiceNo length is lessthan 10."};
  }  
  if(ptName.toLowerCase() == "mobile" || ptAmharicName.toLowerCase() == "ሞባይል")
  {
    if(pmName.toLowerCase() == "telebirr" || pmAmharicName.toLowerCase() == "ቴሌብር")
    {
      invoiceNo = await extractInvoiceNumber(pmName, sms);
      if(!invoiceNo)
      {
        return {result:null,success:false,timeout:false,errorMessage:"❌ የግብይት ቁጥር አልተገኘም። እባክዎ ሙሉውን የSMS መልእክት ወይም የግብይት ቁጥሩን ይላኩ"};
      }
      result = await extractTransactionInfofromThirdParty(
  pmName,
  invoiceNo
);

console.log(
  `Transaction Information for Type = ${pmName}:`,
  result
);

if (result.timeout || result.unavailable) {
  return {
    result: null,
    success: false,
    timeout: !!result.timeout,
    unavailable: !!result.unavailable,
    errorMessage:"❌ ሰርቨሩ ተጨናንቆአል ትንሽ ቆይተው እንደገና ይሞክሩ"
  };
}

if (result.ok) {
  return {
    result: result.data,
    success: true,
    timeout: false,
    errorMessage: "Successful"
  };
}

return {
  result: result.data || null,
  success: false,
  timeout: false,
  errorMessage: "Unsuccessful"
};    
    }
    else if(pmName.toLowerCase() == "m-pesa" || pmAmharicName == "ኤም-ፔሳ")
    {
      invoiceNo = await extractInvoiceNumber(pmName, sms);
      if(!invoiceNo)
      {
        return {result:null,success:false,timeout:false,errorMessage:"❌ የግብይት ቁጥር አልተገኘም። እባክዎ ሙሉውን የSMS መልእክት ወይም የግብይት ቁጥሩን ይላኩ"};
      }
      result = await extractTransactionInfofromThirdParty(pmName, invoiceNo);
      console.log(`Transaction Information for Type = ${pmName}:`);
      console.log(result);
      if(result && (result.timeout || result.unavailable))
          {
              return {result:null,success:false,timeout:!!result.timeout,unavailable:!!result.unavailable,errorMessage:"❌ ሰርቨሩ ተጨናንቆአል ትንሽ ቆይተው እንደገና ይሞክሩ"};
          }
      if(result && result.ok === true)
          {
              return {result,success:true,errorMessage:"successfull"};
          }
      else
          {
              return {result,success:false,errorMessage:"unsuccessfull"};
          }   
    }
    else if(pmName.toLowerCase() == "cbebirr" || pmAmharicName == "ሲቢኢ ብር")
    {
      return null;
    }
    else
    {
      return null;
    }
  }
  else if(ptName.toLowerCase() == "bank" || ptAmharicName == "ባንክ")
  {
    if(pmName.toLowerCase() == "cbe" || pmAmharicName == "ኢትዮጵያ ንግድ ባንክ")
    {
        return null;
    }
  }
  else if(ptName.toLowerCase() == "mobile agent" || ptAmharicName == "ሞባይል ኤጀንት")
  {
      return null;
  }
  else
  {
      return null;
  }
}


// Export functions
module.exports = {
  extractInvoiceNumber,
  parseReceiptNumber,
  builURLfromInvoiceNo,
  checkUrl,
  extractTransactionInfo,
  processDeposit
};
