import { useState } from 'react';
import LoginScreen from './screens/LoginScreen';
import TableMapScreen from './screens/TableMapScreen';
import OrderScreen from './screens/OrderScreen';
import KitchenScreen from './screens/KitchenScreen';
import AdminScreen from './screens/AdminScreen';
import BarScreen from './screens/BarScreen';
import './App.css';

export default function App() {
  const [staff, setStaff] = useState(null);
  const [screen, setScreen] = useState('tables');
  const [activeOrder, setActiveOrder] = useState(null);

  if (!staff) return <LoginScreen onLogin={setStaff} />;
  if (staff.role === 'kitchen') return <KitchenScreen />;
  if (staff.role === 'bar') return <BarScreen />;

  if (screen === 'order' && activeOrder) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f5f5f5' }}>
        <nav className="navbar">
          <span className="navbar-brand">SiamEPOS</span>
          <div className="navbar-user">
            <span>{staff.name}</span>
            <button className="logout-btn" onClick={() => setStaff(null)}>Log out</button>
          </div>
        </nav>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <OrderScreen
            orderId={activeOrder.orderId}
            tableId={activeOrder.tableId}
            staff={staff}
            onClose={() => {
              setActiveOrder(null);
              setScreen('tables');
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="navbar">
        <span className="navbar-brand">SiamEPOS</span>
        <div className="navbar-links">
          <button className={screen === 'tables' ? 'active' : ''} onClick={() => setScreen('tables')}>Tables</button>
          {staff.role === 'admin' && (
            <button className={screen === 'admin' ? 'active' : ''} onClick={() => setScreen('admin')}>Admin</button>
          )}
          <button className={screen === 'kitchen' ? 'active' : ''} onClick={() => setScreen('kitchen')}>Kitchen view</button>
          <button className={screen === 'bar' ? 'active' : ''} onClick={() => setScreen('bar')}>Bar</button>
        </div>
        <div className="navbar-user">
          <span>{staff.name}</span>
          <button className="logout-btn" onClick={() => setStaff(null)}>Log out</button>
        </div>
      </nav>
      <main className="main-content">
        {screen === 'tables' && (
          <TableMapScreen
            staff={staff}
            onOpenOrder={(orderId, tableId) => {
              setActiveOrder({ orderId, tableId });
              setScreen('order');
            }}
          />
        )}
        {screen === 'kitchen' && <KitchenScreen />}
        {screen === 'bar' && <BarScreen />}
        {screen === 'admin' && <AdminScreen />}
      </main>
    </div>
  );
}