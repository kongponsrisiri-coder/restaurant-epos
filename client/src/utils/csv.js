// Shared CSV download helper for admin report exports.
// Wrapped in a BOM so Excel opens it with the right encoding by default.
//
// Usage:
//   const rows = [['Header A','Header B'], ['row1a','row1b'], ...];
//   downloadCsv('my-report_2026-05-22.csv', rows);

export function downloadCsv(filename, rows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = '﻿' + rows.map(r => r.map(escape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
