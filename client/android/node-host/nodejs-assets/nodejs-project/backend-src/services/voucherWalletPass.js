// SEPOS-WALLET-001 — Apple Wallet .pkpass generator for gift vouchers.
//
// Given a voucher row, produces a signed .pkpass Buffer that the
// recipient can add to their iPhone Wallet (or Mac Wallet). Used by
// GET /api/widget/voucher/:code/wallet-pass in server.js.
//
// Cert wiring (set on Railway):
//   PASS_SIGNER_CERT_B64       base64-encoded signer cert PEM
//   PASS_SIGNER_KEY_B64        base64-encoded encrypted signer key PEM
//   PASS_SIGNER_KEY_PASSPHRASE passphrase used when exporting the .p12
//
// The Apple WWDR G4 intermediate cert is committed at wallet/wwdr.pem
// (public Apple cert, not a secret). Pass template (icons + logo +
// pass.json skeleton) lives at wallet/voucher.pass/.

const fs   = require('fs');
const path = require('path');
const { PKPass } = require('passkit-generator');

const MODEL_DIR = path.join(__dirname, 'wallet', 'voucher.pass');
const WWDR_PATH = path.join(__dirname, 'wallet', 'wwdr.pem');

// ── Cert loading (once at startup) ─────────────────────────────────
let _wwdr, _signerCert, _signerKey, _signerKeyPassphrase, _configured = false;

function loadCerts() {
  if (_configured) return true;

  const certB64 = process.env.PASS_SIGNER_CERT_B64;
  const keyB64  = process.env.PASS_SIGNER_KEY_B64;
  const pass    = process.env.PASS_SIGNER_KEY_PASSPHRASE;

  if (!certB64 || !keyB64 || !pass) {
    return false; // Wallet pass disabled — endpoint will 503
  }

  try {
    _wwdr        = fs.readFileSync(WWDR_PATH);
    _signerCert  = Buffer.from(certB64, 'base64');
    _signerKey   = Buffer.from(keyB64,  'base64');
    _signerKeyPassphrase = pass;
    _configured = true;
    return true;
  } catch (err) {
    console.error('[wallet] cert load failed:', err.message);
    return false;
  }
}

function isConfigured() {
  return loadCerts();
}

// ── Helpers ────────────────────────────────────────────────────────
const RESTAURANT_NAME    = process.env.RESTAURANT_NAME    || 'SiamEPOS Restaurant';
const RESTAURANT_ADDRESS = process.env.RESTAURANT_ADDRESS || '';
const RESTAURANT_EMAIL   = process.env.RESTAURANT_EMAIL   || 'info@siamepos.co.uk';

function formatExpiry(expiresAt) {
  if (!expiresAt) return '';
  const dateStr = (expiresAt instanceof Date)
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

// Wallet stores numeric Date as ISO with timezone — set expiration to
// end of expiry day in UTC so the pass auto-greys at the right moment.
function expiryIsoEndOfDay(expiresAt) {
  if (!expiresAt) return undefined;
  const dateStr = (expiresAt instanceof Date)
    ? expiresAt.toISOString().slice(0, 10)
    : String(expiresAt).slice(0, 10);
  return dateStr + 'T23:59:59Z';
}

// ── Main generator ─────────────────────────────────────────────────
// Returns a Buffer (the signed .pkpass zip). Caller writes it to res
// with content-type application/vnd.apple.pkpass.
async function buildVoucherPass(voucher) {
  if (!isConfigured()) {
    const e = new Error('Wallet pass not configured on server');
    e.code = 'PASS_NOT_CONFIGURED';
    throw e;
  }

  const code     = voucher.code;
  const amount   = Number(voucher.original_amount || 0);
  const balance  = Number(voucher.balance || amount);
  const expires  = formatExpiry(voucher.expires_at);
  const expIso   = expiryIsoEndOfDay(voucher.expires_at);
  const toName   = voucher.recipient_name || '';
  const amountFmt  = '£' + amount.toFixed(2);
  const balanceFmt = '£' + balance.toFixed(2);

  // serialNumber must be unique per pass — use voucher code (it already
  // is unique + stable). Apple uses this as the Wallet-side identity.
  const pass = await PKPass.from({
    model: MODEL_DIR,
    certificates: {
      wwdr:                _wwdr,
      signerCert:          _signerCert,
      signerKey:           _signerKey,
      signerKeyPassphrase: _signerKeyPassphrase,
    },
  }, {
    serialNumber:     code,
    description:      `${RESTAURANT_NAME} Gift Voucher`,
    organizationName: RESTAURANT_NAME,
    ...(expIso ? { expirationDate: expIso } : {}),
  });

  // BALANCE — big number front of pass. Falls back to original amount
  // for freshly issued passes (where balance === original_amount).
  pass.primaryFields.push({
    key:   'balance',
    label: 'Balance',
    value: balanceFmt,
  });

  // CODE + EXPIRES on the second row.
  pass.secondaryFields.push(
    { key: 'code',    label: 'Code',    value: code },
    { key: 'expires', label: 'Expires', value: expires || 'No expiry' },
  );

  // FOR (recipient) on auxiliary row — only if we have a name. Original
  // voucher value also exposed here for reference once partially redeemed.
  if (toName) {
    pass.auxiliaryFields.push({ key: 'recipient', label: 'For', value: toName });
  }
  if (Math.abs(balance - amount) > 0.001) {
    pass.auxiliaryFields.push({ key: 'original', label: 'Original value', value: amountFmt });
  }

  // Back of pass — long-form terms + how to use + restaurant address.
  pass.backFields.push(
    {
      key:   'how_to_use',
      label: 'How to use',
      value: `Show this pass when paying at ${RESTAURANT_NAME}. The cashier will scan the QR code or enter the voucher code to apply your balance to the bill. Voucher can be used over multiple visits until balance is fully redeemed.`,
    },
    {
      key:   'restaurant',
      label: 'Where to use',
      value: RESTAURANT_ADDRESS ? `${RESTAURANT_NAME}\n${RESTAURANT_ADDRESS}` : RESTAURANT_NAME,
    },
    {
      key:   'terms',
      label: 'Terms & Conditions',
      value: 'Non-refundable. Not exchangeable for cash. Valid until the expiry date shown. One voucher per transaction unless agreed by the restaurant. Lost or stolen vouchers cannot be replaced.',
    },
    {
      key:   'support',
      label: 'Support',
      value: RESTAURANT_EMAIL,
    },
  );

  // QR code containing the voucher code — staff can scan it from the
  // recipient's phone instead of typing it in.
  pass.setBarcodes({
    format:          'PKBarcodeFormatQR',
    message:         code,
    messageEncoding: 'iso-8859-1',
    altText:         code,
  });

  return pass.getAsBuffer();
}

module.exports = {
  buildVoucherPass,
  isConfigured,
};
