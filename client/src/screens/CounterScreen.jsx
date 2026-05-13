// SEPOS-045 — Counter mode home screen.
//
// Behaviour: when the device's localStorage.counter_mode is '1', the
// home tab renders this component instead of TableMapScreen. On mount
// it creates a fresh tableless order (order_type='counter') and hands
// it to OrderScreen. When staff hit Pay or Back, the order closes the
// normal way and we immediately spin up the NEXT empty counter order
// so the till is always ready for the next customer.
//
// No table picker, no covers prompt, no service charge — the bill flow
// already skips service charge for non-dine_in orders.

import { useEffect, useState, useCallback } from 'react';
import { createCounterOrder } from '../api';
import OrderScreen from './OrderScreen';

export default function CounterScreen({ staff }) {
  const [orderId, setOrderId] = useState(null);
  const [err, setErr] = useState('');

  const startNewOrder = useCallback(async () => {
    setErr('');
    try {
      const r = await createCounterOrder(staff?.id || null);
      if (r && r.id) setOrderId(r.id);
      else throw new Error('No order id returned');
    } catch (e) {
      setErr(e.message || 'Failed to start counter order');
    }
  }, [staff?.id]);

  useEffect(() => { startNewOrder(); }, [startNewOrder]);

  // When the order closes (paid or back-out), reset to a fresh one.
  const onOrderClosed = useCallback(() => {
    setOrderId(null);
    startNewOrder();
  }, [startNewOrder]);

  if (err) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <div style={{ color: '#991b1b', marginBottom: 16, fontWeight: 700 }}>{err}</div>
        <button onClick={startNewOrder} style={{
          background: '#0d1b3e', color: 'white', border: 'none',
          padding: '10px 20px', borderRadius: 8, fontWeight: 700, cursor: 'pointer',
        }}>Retry</button>
      </div>
    );
  }

  if (!orderId) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
        🛒 Starting counter order…
      </div>
    );
  }

  return (
    <OrderScreen
      key={orderId}           /* force remount on next-order so internal state resets */
      orderId={orderId}
      tableId={null}
      staff={staff}
      onClose={onOrderClosed}
    />
  );
}
