const cheerio = require("cheerio");

let str = `Dear Zelalem 
You have transferred ETB 60.00 to EBA BEKELE (2519****2998) on 05/09/2026 14:58:29. Your transaction number is DI51GT7815. The service fee is  ETB 0.87 and  15% VAT on the service fee is ETB 0.13. Your current E-Money Account  balance is ETB 0.00. To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/DI51GT7815.

Thank you for using telebirr
Ethio telecom`;

// Extract invoice number from the URL in the message
const match = str.match(
  /https:\/\/transactioninfo\.ethiotelecom\.et\/receipt\/([^.\s]+)/i
);

const invoiceNo = match ? match[1] : null;

console.log("Invoice No:", invoiceNo);

let urlFirst = "https://transactioninfo.ethiotelecom.et/";

// Construct full URL
const url = `${urlFirst}receipt/${invoiceNo}`;

console.log("Receipt URL:", url);


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

async function main() {

  if (!invoiceNo) {
    console.log("No invoice number found.");
    return;
  }

  // First check URL
  const isValid = await checkUrl(url);

  if (!isValid) {
    console.log("Stopping. Receipt URL is invalid.");
    return;
  }

  // Only continue if URL is valid
  const result = await extractTransactionInfo(url);

  console.log("Transaction Information:");
  console.log(result);
}

main();