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

async function extractInvoiceNumber(typeName, sms) 
{
  let match = "";
  let invoiceNo = "";
  if(typeName.toLowerCase() === "telebirr")
  {
    match = sms.match(/https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([^.\s]+)/i);
  }
  else if(typeName.toLowerCase() === "m-pesa")
  {
    match = sms.match(/https:\/\/m-pesabusiness\.safaricom\.et\/receipt\/([^.\s]+)/i);
  }
  else 
  {
    match = "";
  }  
  invoiceNo = match ? match[1] : null;
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

async function extractTransactionInfofromThirdParty(typeName, receiptId) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 10000);

  try {
    const url =
      `https://checkit.et/api/process.php?type=${encodeURIComponent(
        typeName.toLowerCase()
      )}&receiptid=${encodeURIComponent(receiptId)}`;

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    const contentType = response.headers.get("content-type") || "";

    if (!response.ok) {
      const body = await response.text();

      console.error(
        `Checkit HTTP ${response.status}:`,
        body.slice(0, 500)
      );

      return {
        ok: false,
        timeout: false,
        error: `HTTP ${response.status}`
      };
    }

    if (!contentType.includes("application/json")) {
      const body = await response.text();

      console.error(
        "Checkit returned non-JSON response:",
        body.slice(0, 500)
      );

      return {
        ok: false,
        timeout: false,
        error: "Non-JSON response"
      };
    }

    const data = await response.json();

    if (!data.ok) {
      console.log("Checkit API error:", data);

      return {
        ok: false,
        timeout: false,
        error: "Checkit API returned ok=false",
        data
      };
    }

    return {
      ok: true,
      timeout: false,
      data
    };

  } catch (error) {

    if (error.name === "AbortError") {
      console.error("Checkit API timed out after 10 seconds");

      return {
        ok: false,
        timeout: true,
        error: "Checkit timeout"
      };
    }

    console.error("Checkit API request failed:", error);

    return {
      ok: false,
      timeout: false,
      error: error.message
    };

  } finally {
    clearTimeout(timeout);
  }
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
  if(ptName.toLowerCase() == "Mobile" || ptAmharicName.toLowerCase() == "ሞባይል")
  {
    if(pmName.toLowerCase() == "telebirr" || pmAmharicName.toLowerCase() == "ቴሌብር")
    {
      if(sms.length > 10)
      {
          invoiceNo = await extractInvoiceNumber(pmName, sms);         
      }
      else
      {
          invoiceNo = sms;
      }
      result = await extractTransactionInfofromThirdParty(
  pmName,
  invoiceNo
);

console.log(
  `Transaction Information for Type = ${pmName}:`,
  result
);

if (result.timeout) {
  return {
    result: null,
    success: false,
    timeout: true,
    errorMessage:
      "ሰርቨሩ ተጨናንቆአል ትንሽ ቆይተው እንደገና ይሞክሩ"
  };
}

if (result.ok) {
  return {
    result: result.data,
    success: true,
    timeout: false,
    errorMessage: "successful"
  };
}

return {
  result: result.data || null,
  success: false,
  timeout: false,
  errorMessage: "unsuccessful"
};    
    }
    else if(pmName.toLowerCase() == "m-pesa" || pmAmharicName == "ኤም-ፔሳ")
    {
      if(sms.length > 10)
      {
          invoiceNo = await extractInvoiceNumber(pmName, sms);         
      }
      else
      {
          invoiceNo = sms;
      }
      result = await extractTransactionInfofromThirdParty(pmName, invoiceNo);
      console.log(`Transaction Information for Type = ${pmName}:`);
      console.log(result);
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
  builURLfromInvoiceNo,
  checkUrl,
  extractTransactionInfo,
  processDeposit
};
