const cheerio = require("cheerio");

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

async function extractTransactionInfofromThirdParty(url) {

  const response = await fetch("https://links.et/api/verify", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.LINKS_API_KEY
  },
  body: JSON.stringify({
    url: url
  })
});
  const data = await response.json();
  if (!response.ok) {
      console.log("Verification API error:", data);
      return null;
    }
  
  return data;  
}
// ─────────────────────────────────────────────
// MAIN DEPOSIT PROCESS
// ─────────────────────────────────────────────

async function processDeposit(sms,pmName,pmAmharicName,ptName,ptAmharicName) 
{  
  let invoiceNo = "";
  if(sms.length > 10)
  {
        if(ptName == "Mobile" || ptAmharicName == "ሞባይል")
        {
          if(pmName == "telebirr" || pmAmharicName == "ቴሌብር")
          {
             invoiceNo = extractInvoiceNumbertelebirr(sms);
          }
          else if(pmName == "M-PESA" || pmAmharicName == "ኤም-ፔሳ")
          {
            invoiceNo = extractInvoiceNumbermpessa(sms);
          }
          else if(pmName == "CBEBirr" || pmAmharicName == "ሲቢኢ ብር")
          {
            invoiceNo = extractInvoiceNumbercbebirr(sms);
          }
          else
          {
          }
        }
        else if(ptName == "Bank" || ptAmharicName == "ባንክ")
        {
          if(pmName == "CBE" || pmAmharicName == "ኢትዮጵያ ንግድ ባንክ")
          {
            invoiceNo = extractInvoiceNumbertelebirr(sms);
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

  console.log("invoice number:->",invoiceNo);

  if (invoiceNo == null || invoiceNo == "") {
    console.log("No invoice number found.");
    return 1;
  }

  // Build URL
  const url = await builURLfromInvoiceNo(invoiceNo);
  
  const isValid = await checkUrl("https://links.et/");

  if (!isValid) {
    console.log("Stopping. Receipt URL is invalid.");
    return 2;
  }


  //const result = await extractTransactionInfo(url);
  const result = await extractTransactionInfofromThirdParty(url);
  

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
