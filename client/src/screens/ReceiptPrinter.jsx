/**
 * SiamEPOS Receipt Printer — SEPOS-020
 * Browser-based thermal receipt printing
 * Works with Epson TM-T20, Star TSP100, and any 80mm thermal printer
 * set as the default printer in Chrome/browser settings.
 *
 * Usage:
 *   import { printReceipt } from './ReceiptPrinter';
 *   printReceipt({ order, items, settings, paymentDetails });
 */

/**
 * Main print function — call this to trigger receipt print
 * @param {Object} params
 * @param {Object} params.order       - order object (id, table_number, covers, etc.)
 * @param {Array}  params.items       - order items array
 * @param {Object} params.settings    - restaurant settings from /api/settings
 * @param {Object} params.paymentDetails - { method, amountPaid, tip, change }
 */
export function printReceipt({ order, items, settings, paymentDetails = {} }) {
  const html = buildReceiptHTML({ order, items, settings, paymentDetails });

  // Open a small print window
  const win = window.open('', '_blank', 'width=400,height=700,scrollbars=yes');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site to print receipts.');
    return;
  }

  win.document.write(html);
  win.document.close();

  // Wait for content to render then print
  win.onload = () => {
    setTimeout(() => {
      win.focus();
      win.print();
      // Close after print dialog closes
      win.onafterprint = () => win.close();
    }, 300);
  };
}

function buildReceiptHTML({ order, items, settings, paymentDetails }) {
  const restaurantName = settings?.restaurant_name || 'SiamEPOS Restaurant';
  const restaurantAddr = settings?.address || '';
  const restaurantPhone = settings?.phone || '';
  const googleReviewUrl = settings?.google_review_url || '';
  const scEnabled = settings?.service_charge_enabled === 'true' || settings?.service_charge_enabled === true;
  const scRate     = parseFloat(settings?.service_charge_rate || 12.5);

  const now   = new Date();
  const date  = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time  = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // Calculate totals
  const activeItems = items.filter(i => !i.voided);
  const subtotal    = activeItems.reduce((sum, i) => {
    const itemTotal = i.quantity * i.unit_price;
    if (i.discount_type === 'percent') return sum + itemTotal * (1 - (i.discount_value || 0) / 100);
    if (i.discount_type === 'fixed')   return sum + Math.max(0, itemTotal - (i.discount_value || 0));
    return sum + itemTotal;
  }, 0);

  // Order-level discount
  let discountAmount = 0;
  if (order.discount_type === 'percent' && order.discount_value) {
    discountAmount = subtotal * (order.discount_value / 100);
  } else if (order.discount_type === 'fixed' && order.discount_value) {
    discountAmount = parseFloat(order.discount_value);
  }
  const afterDiscount = subtotal - discountAmount;

  const scAmount  = scEnabled ? afterDiscount * (scRate / 100) : 0;
  const tip       = parseFloat(paymentDetails.tip || 0);
  const total     = afterDiscount + scAmount + tip;
  const paid      = parseFloat(paymentDetails.amountPaid || total);
  const change    = Math.max(0, paid - total);
  const method    = paymentDetails.method || 'Card';

  // Group items by course for cleaner receipt
  const courseNames = { 1: 'Starters', 2: 'Mains', 3: 'Desserts', 4: 'Extras' };
  const byCourse = {};
  activeItems.forEach(item => {
    const c = item.course || 1;
    if (!byCourse[c]) byCourse[c] = [];
    byCourse[c].push(item);
  });

  const itemRows = Object.keys(byCourse).sort().map(course => {
    const courseItems = byCourse[course];
    const rows = courseItems.map(item => {
      const itemTotal = item.quantity * item.unit_price;
      let finalPrice = itemTotal;
      if (item.discount_type === 'percent') finalPrice = itemTotal * (1 - (item.discount_value || 0) / 100);
      if (item.discount_type === 'fixed')   finalPrice = Math.max(0, itemTotal - (item.discount_value || 0));
      const name = item.name || item.item_name || 'Item';
      const hasDiscount = item.discount_value > 0;
      return `
        <tr>
          <td style="padding:2px 0;">${item.quantity}x ${name}</td>
          <td style="text-align:right;padding:2px 0;">${fmt(finalPrice)}</td>
        </tr>
        ${hasDiscount ? `<tr><td style="padding-left:12px;font-size:10px;color:#666;">  discount applied</td><td></td></tr>` : ''}
        ${item.notes ? `<tr><td style="padding-left:12px;font-size:10px;color:#666;">  ${item.notes}</td><td></td></tr>` : ''}
      `;
    }).join('');
    return `
      <tr><td colspan="2" style="padding-top:6px;padding-bottom:2px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999;">${courseNames[course] || 'Items'}</td></tr>
      ${rows}
    `;
  }).join('');

  const discountRow = discountAmount > 0 ? `
    <tr>
      <td>Discount ${order.discount_type === 'percent' ? `(${order.discount_value}%)` : ''}</td>
      <td style="text-align:right;">-${fmt(discountAmount)}</td>
    </tr>` : '';

  const scRow = scEnabled ? `
    <tr>
      <td>Service charge (${scRate}%)</td>
      <td style="text-align:right;">${fmt(scAmount)}</td>
    </tr>` : '';

  const tipRow = tip > 0 ? `
    <tr>
      <td>Gratuity</td>
      <td style="text-align:right;">${fmt(tip)}</td>
    </tr>` : '';

  const changeRow = method === 'Cash' && change > 0 ? `
    <tr>
      <td>Cash tendered</td>
      <td style="text-align:right;">${fmt(paid)}</td>
    </tr>
    <tr style="font-weight:700;">
      <td>Change</td>
      <td style="text-align:right;">${fmt(change)}</td>
    </tr>` : '';

  const qrSection = googleReviewUrl ? `
    <div style="text-align:center;margin-top:10px;">
      <div style="font-size:10px;color:#666;margin-bottom:4px;">Enjoyed your meal? Leave us a review!</div>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(googleReviewUrl)}" 
           width="80" height="80" alt="Google Review QR" style="border:1px solid #eee;" />
      <div style="font-size:9px;color:#aaa;margin-top:2px;">Scan to review on Google</div>
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Receipt - Table ${order.table_number}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      color: #000;
      background: white;
      width: 80mm;
      margin: 0 auto;
      padding: 4mm 2mm;
    }

    /* ── Print styles ── */
    @media print {
      body {
        width: 80mm;
        margin: 0;
        padding: 2mm 1mm;
      }
      @page {
        margin: 0;
        size: 80mm auto;
      }
    }

    .center  { text-align: center; }
    .right   { text-align: right; }
    .bold    { font-weight: bold; }
    .divider { border: none; border-top: 1px dashed #999; margin: 6px 0; }
    .divider-solid { border: none; border-top: 1px solid #000; margin: 6px 0; }
    .small   { font-size: 10px; color: #555; }

    h1 {
      font-size: 16px;
      font-weight: 900;
      text-align: center;
      letter-spacing: 1px;
      margin-bottom: 2px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    .total-row {
      font-size: 15px;
      font-weight: 900;
    }

    .total-row td {
      padding: 4px 0;
      border-top: 1px solid #000;
    }

    .thank-you {
      text-align: center;
      font-size: 11px;
      margin-top: 10px;
      color: #333;
    }
  </style>
</head>
<body>

  <!-- Restaurant header -->
  <h1>${restaurantName}</h1>
  ${restaurantAddr ? `<p class="center small">${restaurantAddr}</p>` : ''}
  ${restaurantPhone ? `<p class="center small">Tel: ${restaurantPhone}</p>` : ''}

  <hr class="divider" />

  <!-- Order info -->
  <table>
    <tr>
      <td>Table</td>
      <td class="right bold">${order.table_number || '—'}</td>
    </tr>
    <tr>
      <td>Covers</td>
      <td class="right">${order.covers || '—'}</td>
    </tr>
    <tr>
      <td>Date</td>
      <td class="right">${date}</td>
    </tr>
    <tr>
      <td>Time</td>
      <td class="right">${time}</td>
    </tr>
    <tr>
      <td>Order #</td>
      <td class="right">${order.id}</td>
    </tr>
  </table>

  <hr class="divider" />

  <!-- Items -->
  <table>
    ${itemRows}
  </table>

  <hr class="divider" />

  <!-- Totals -->
  <table>
    <tr>
      <td>Subtotal</td>
      <td class="right">${fmt(subtotal)}</td>
    </tr>
    ${discountRow}
    ${scRow}
    ${tipRow}
    <tr class="total-row">
      <td>TOTAL</td>
      <td class="right">${fmt(total)}</td>
    </tr>
    <tr>
      <td>Payment</td>
      <td class="right">${method}</td>
    </tr>
    ${changeRow}
  </table>

  <hr class="divider-solid" />

  <!-- Thank you -->
  <p class="thank-you">
    Thank you for dining with us!<br/>
    ขอบคุณที่มาใช้บริการ
  </p>

  ${qrSection}

  <div style="height:10mm;"></div>

</body>
</html>`;
}

function fmt(amount) {
  return '£' + parseFloat(amount || 0).toFixed(2);
}

/**
 * Quick reprint from bill records — fetches order data then prints
 */
export async function reprintReceipt(orderId, SERVER_URL) {
  try {
    const [billRes, itemsRes, settingsRes] = await Promise.all([
      fetch(`${SERVER_URL}/api/orders/${orderId}/bill`).then(r => r.json()),
      fetch(`${SERVER_URL}/api/bills/${orderId}/items`).then(r => r.json()),
      fetch(`${SERVER_URL}/api/settings`).then(r => r.json()),
    ]);
    printReceipt({
      order:          { ...billRes.order, table_number: billRes.order?.table_number },
      items:          Array.isArray(itemsRes) ? itemsRes : [],
      settings:       { ...settingsRes, ...billRes.settings },
      paymentDetails: { method: 'Card', amountPaid: billRes.order?.total, tip: 0 },
    });
  } catch (e) {
    alert('Could not load receipt data. Please try again.');
    console.error(e);
  }
}
