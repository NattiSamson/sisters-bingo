const cheerio = require("cheerio");

async function extractInvoiceNumber(sms) {
let str = sms;

// Extract invoice number from the URL in the message
const match = str.match(
  /https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([^.\s]+)/i
);

const invoiceNo = match ? match[1] : null;

console.log("Invoice No:", invoiceNo);
  return invoiceNo;
}

async function builURLfromInvoiceNo(invoiceNo) {
let urlFirst = "https://transactioninfo.ethiotelecom.et/";

// Construct full URL
const url = `${urlFirst}receipt/${invoiceNo}`;

console.log("Receipt URL:", url);
return url;
}
// --------------------------------------------------
// CHECK URL
// --------------------------------------------------

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


// --------------------------------------------------
// EXTRACT TRANSACTION INFORMATION
// --------------------------------------------------

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


      // Payer telebirr no.
      if (label.includes("payer telebirr")) {
        result.payerTelebirrNo = value;
      }


      // Credited Party name
      if (label.includes("credited party name")) {
        result.creditedPartyName = value;
      }


      // Credited party account no.
      if (label.includes("credited party account")) {
        result.creditedPartyAccountNo = value;
      }


      // Payment date
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


      // Amount / Settled Amount
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


// --------------------------------------------------
// MAIN
// --------------------------------------------------

async processDeposit(sms) {

 const invoiceNo = extractInvoiceNumber(sms);
  if (invoiceNo == null) {
    console.log("No invoice number found.");
    return 1;
  }

  // Build URL
  const url = builURLfromInvoiceNo(invoiceNo);

  const isValid = await checkUrl(url);

  if (!isValid) {
    console.log("Stopping. Receipt URL is invalid.");    
    return 2;
  }

  // Only continue if URL is valid
  const result = await extractTransactionInfo(url);
  console.log("Transaction Information:");
  console.log(result);
  return result;  
}
