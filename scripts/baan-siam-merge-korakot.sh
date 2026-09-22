#!/bin/zsh
# One-off, Baan Siam DEMO tenant only — merge the 9 "Korakot" contact variants
# (07…/+44…, gmail/googlemail/info@/none) into one identity so the customer
# picker shows a single row. Korakot's own records; nothing else touched.
# Run from the repo root:  ./scripts/baan-siam-merge-korakot.sh
set -e
cd "$(dirname "$0")/.."
PGURL=$(railway variables --service Postgres --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])")
psql "$PGURL" -At <<'SQL'
BEGIN;
UPDATE orders       SET customer_phone='+447896036386', customer_email='kongponsrisiri@gmail.com'
 WHERE customer_name ILIKE '%korakot%' OR customer_phone LIKE '%7896036386%';
UPDATE reservations SET customer_phone='+447896036386', customer_email='kongponsrisiri@gmail.com'
 WHERE customer_name ILIKE '%korakot%' OR customer_phone LIKE '%7896036386%';
COMMIT;
SELECT customer_name, customer_phone, customer_email, count(*) AS rows
  FROM (SELECT customer_name, customer_phone, customer_email FROM orders
        UNION ALL SELECT customer_name, customer_phone, customer_email FROM reservations) x
 WHERE customer_phone LIKE '%7896036386%' GROUP BY 1,2,3;
SQL
