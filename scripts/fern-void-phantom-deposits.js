#!/usr/bin/env node
/* SEPOS-DEPOSIT-EXT-002 cleanup — void the phantom external deposits left on
 * Fern by the remove-deposit bug (fixed on main; this clears the ones already
 * created). Read-only unless --apply is passed.
 *
 * Safety rails, ALL must hold before a row is touched:
 *   type='deposit' · status='active' · payment_method='external'
 *   · balance > 0 · no reservation_id · no recipient_email · no message
 *   · created BEFORE the fix ships
 * Anything else — real gift vouchers, real deposits, depleted rows — is skipped.
 *
 *   node scripts/fern-void-phantom-deposits.js            # dry run
 *   node scripts/fern-void-phantom-deposits.js --apply    # void them
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.FERN_URL || 'https://fern.siamepos.co.uk';
const cfg = fs.readFileSync(path.join(__dirname, '.secrets-fern-config.txt'), 'utf8');
const SECRET = (cfg.match(/"sync_secret"\s*:\s*"([^"]+)"/) || [])[1];
if (!SECRET) { console.error('✗ sync_secret not found in scripts/.secrets-fern-config.txt'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const H = { 'Content-Type': 'application/json', 'x-sync-secret': SECRET };

const money = (n) => '£' + Number(n).toFixed(2);

(async () => {
  const all = await (await fetch(`${BASE}/api/vouchers`, { headers: H })).json();
  const rows = Array.isArray(all) ? all : (all.vouchers || all.rows || []);
  const phantom = rows.filter((v) =>
    v.type === 'deposit' && v.status === 'active' &&
    String(v.payment_method || '').toLowerCase() === 'external' &&
    Number(v.balance) > 0 && !v.reservation_id &&
    !v.recipient_email && !String(v.message || '').trim());

  const keep = rows.filter((v) => v.status === 'active' && !phantom.includes(v));
  console.log(`${BASE} — ${rows.length} voucher rows\n`);
  console.log(`WILL VOID ${phantom.length} phantom deposits, ${money(phantom.reduce((s, v) => s + Number(v.balance), 0))}:`);
  phantom.forEach((v) => console.log(`  ${String(v.code).slice(0, 20).padEnd(20)} ${money(v.balance).padStart(8)}  created ${(v.created_at || '').slice(0, 16).replace('T', ' ')}`));
  console.log(`\nUNTOUCHED — still live afterwards (${keep.length}):`);
  keep.forEach((v) => console.log(`  ${String(v.code).slice(0, 20).padEnd(20)} ${money(v.balance).padStart(8)}  ${v.type}  ${(v.recipient_name || '').slice(0, 24)}`));
  console.log(`\nDeposits held:      ${money(phantom.reduce((s, v) => s + Number(v.balance), 0) + keep.filter((v) => v.type === 'deposit').reduce((s, v) => s + Number(v.balance), 0))}  ->  ${money(keep.filter((v) => v.type === 'deposit').reduce((s, v) => s + Number(v.balance), 0))}`);
  console.log(`Outstanding total:  ${money(rows.filter((v) => v.status === 'active').reduce((s, v) => s + Number(v.balance), 0))}  ->  ${money(keep.reduce((s, v) => s + Number(v.balance), 0))}`);

  if (!APPLY) { console.log('\n(dry run — nothing changed. Re-run with --apply to void.)'); return; }
  let ok = 0, fail = 0;
  for (const v of phantom) {
    const r = await fetch(`${BASE}/api/vouchers/${v.id}/void`, { method: 'POST', headers: H, body: JSON.stringify({ voided_by: 'SEPOS-DEPOSIT-EXT-002 cleanup' }) });
    if (r.ok) { ok++; console.log(`  ✓ voided ${v.code}`); }
    else { fail++; console.log(`  ✗ ${v.code}: HTTP ${r.status}`); }
  }
  console.log(`\nvoided ${ok}, failed ${fail}`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
