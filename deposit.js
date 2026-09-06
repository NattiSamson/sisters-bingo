const cheerio = require("cheerio");

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


async function checkUrl(url, timeout = 5000) {
 try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    console.log(`URL: ${url}`);
    console.log(`HTTP status: ${response.status}`);

    if (!response.ok) {
      console.log("URL returned an error");
      return false;
    }

    return true;

  } catch (error) {
    console.error("URL check failed:", error);

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


// ─────────────────────────────────────────────
// MAIN DEPOSIT PROCESS
// ─────────────────────────────────────────────

async function processDeposit(sms) {

  const invoiceNo = await extractInvoiceNumber(sms);

  if (invoiceNo == null) {
    console.log("No invoice number found.");
    return 1;
  }

  // Build URL
  const url = await builURLfromInvoiceNo(invoiceNo);

  // Check URL
  const isValid = await checkUrl(url);

  if (!isValid) {
    console.log("Stopping. Receipt URL is invalid.");
    return 2;
  }

  // Extract transaction information
  const result = await extractTransactionInfo(url);

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
