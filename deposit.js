const cheerio = require("cheerio");
/*{ok: true,
providerKey: "telebirr",
resolvedUrl: "https://transactioninfo.ethiotelecom.et/receipt/CJF7HITHQF",
httpStatus: 200,
fetchedAt: "2026-09-06T09:40:07.363Z",
receipt: {
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

async function extractInvoiceNumbertelebirr(sms) {
  const match = sms.match(
    /https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([^.\s]+)/i
  );

  const invoiceNo = match ? match[1] : null;

  console.log("Invoice No:", invoiceNo);

  return invoiceNo;
}

async function extractInvoiceNumbercbebirr(sms) {

  const invoiceNo = null;

  console.log("Invoice No:", invoiceNo);

  return invoiceNo;
}

async function extractInvoiceNumbermpessa(sms) {
  
  const invoiceNo = null;

  console.log("Invoice No:", invoiceNo);

  return invoiceNo;
}

async function extractInvoiceNumbercbe(sms) {  

  const invoiceNo = null;

  console.log("Invoice No:", invoiceNo);

  return invoiceNo;
}

async function extractInvoiceNumber(sms) {
  const match = sms.match(
    /https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([^.\s]+)/i
  );

  const invoiceNo = match ? match[1] : null;

  console.log("Invoice No:", invoiceNo);

  return invoiceNo;
}


async function builURLfromInvoiceNo(invoiceNo) {
  const url = `https://transactioninfo.ethiotelecom.et/receipt/${invoiceNo}`;

  console.log("Receipt URL:", url);

  return url;
}


async function checkUrl(url) {
  
try {
    const response = await fetch(url);

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
    const response = await fetch(url);

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

async function extractTransactionInfofromThirdParty(url, type) {
  try {
    const receiptUrl = new URL(url);
    const receiptId = receiptUrl.pathname
      .split("/")
      .filter(Boolean)
      .pop();

    if (!receiptId) {
      console.error("Could not extract receipt ID from URL");
      return null;
    }

    const response = await fetch(
      `https://checkit.et/api/process.php?type=${encodeURIComponent(type)}&receiptid=${encodeURIComponent(receiptId)}`
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      console.log("Checkit API error:", data);
      return null;
    }

    return data;

  } catch (error) {
    console.error("Checkit API request failed:", error);
    return null;
  }
}
// ─────────────────────────────────────────────
// MAIN DEPOSIT PROCESS
// ─────────────────────────────────────────────

async function processDeposit(sms,pmName,pmAmharicName,ptName,ptAmharicName) 
{  
  let invoiceNo = "";
  let type = 1;
  if(sms.length > 10)
  {
        if(ptName == "Mobile" || ptAmharicName == "ሞባይል")
        {
          if(pmName == "telebirr" || pmAmharicName == "ቴሌብር")
          {
             invoiceNo = await extractInvoiceNumbertelebirr(sms);
             type = 1;
          }
          else if(pmName == "M-PESA" || pmAmharicName == "ኤም-ፔሳ")
          {
            invoiceNo = await extractInvoiceNumbermpessa(sms);
            type = 2;
          }
          else if(pmName == "CBEBirr" || pmAmharicName == "ሲቢኢ ብር")
          {
            invoiceNo = await extractInvoiceNumbercbebirr(sms);
          }
          else
          {
          }
        }
        else if(ptName == "Bank" || ptAmharicName == "ባንክ")
        {
          if(pmName == "CBE" || pmAmharicName == "ኢትዮጵያ ንግድ ባንክ")
          {
            invoiceNo = await extractInvoiceNumbertelebirr(sms);
          }
        }
        else if(ptName == "Mobile Agent" || ptAmharicName == "ሞባይል ኤጀንት")
        {
        }
        else
        {
        }
  }
  else
  {
    invoiceNo = sms;
  }

  

  if (invoiceNo == null || invoiceNo == "") {
    console.log("No invoice number found.");
    return 1;
  }

  // Build URL
  //const url = await builURLfromInvoiceNo(invoiceNo);
  console.log("i'm here:",invoiceNo);
  
//  const isValid = await checkUrl("https://links.et/");
    const isValid = await checkUrl("https://checkit.et/");

  if (!isValid) {
    console.log("Checking URL is not responding");
    return 2;
  }


  //const result = await extractTransactionInfo(url);
  const result = await extractTransactionInfofromThirdParty(url,type);
  

  console.log("Transaction Information:");
  console.log(result);

  return result;
}


// Export functions
module.exports = {
  extractInvoiceNumber,
  builURLfromInvoiceNo,
  checkUrl,
  extractTransactionInfo,
  processDeposit
};
