import { useState } from 'react';
import TradingSection   from './admin/TradingSection';
import MenuSection      from './admin/MenuSection';
import TablePlanSection from './admin/TablePlanSection';
import ReportsSection   from './admin/ReportsSection';
import BillsSection     from './admin/BillsSection';
import ZReportSection   from './admin/ZReportSection';
import StaffSection     from './admin/StaffSection';
import CustomersSection   from './admin/CustomersSection';
import CampaignsSection   from './admin/CampaignsSection';
import ClockRecordsSection from './admin/ClockRecordsSection';
import StaffPerformanceSection from './admin/StaffPerformanceSection';
import VATReportSection from './admin/VATReportSection';
import AllergenSection  from './admin/AllergenSection';
import SettingsSection  from './admin/SettingsSection';
import InventorySection from './admin/inventory/InventorySection';
import ReservationSettingsSection from './admin/ReservationSettingsSection';

export default function AdminScreen() {
  const [section, setSection] = useState('trading');

  const navItems = [
    { id: 'trading',      label: '📊 Trading' },
    { id: 'menu',         label: '🍽️ Menu' },
    { id: 'tableplan',    label: '🗺️ Table Plan' },
    { id: 'reports',      label: '📈 Reports' },
    { id: 'bills',        label: '🧾 Bills' },
    { id: 'zreport',      label: '🔐 Z Report' },
    { id: 'staff',        label: '👥 Staff' },
    { id: 'customers',    label: '🧑‍🤝‍🧑 Customers' },
    { id: 'campaigns',    label: '📧 Campaigns' },
    { id: 'clock',        label: '🕐 Clock Records' },
    { id: 'performance',  label: '📊 Staff Performance' },
    { id: 'vat',          label: '🧾 VAT Report' },
    { id: 'inventory',    label: '🥬 Inventory' },
    { id: 'allergens',    label: '🌿 Allergens' },
    { id: 'settings',     label: '⚙️ Settings' },
    { id: 'reservations', label: '📅 Reservations' },
  ];

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)' }}>
      <div style={{ width: 200, background: '#1a1a2e', display: 'flex', flexDirection: 'column', padding: '20px 0' }}>
        <div style={{ color: 'white', fontWeight: 700, fontSize: 14, padding: '0 20px 16px', opacity: 0.5, textTransform: 'uppercase', letterSpacing: 1 }}>Admin Panel</div>
        {navItems.map(item => (
          <button key={item.id} onClick={() => setSection(item.id)} style={{ background: section === item.id ? '#e94560' : 'none', border: 'none', color: 'white', padding: '12px 20px', textAlign: 'left', cursor: 'pointer', fontSize: 14, fontWeight: section === item.id ? 700 : 400 }}>{item.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: section === 'inventory' ? 'hidden' : 'auto', background: '#f5f5f5' }}>
        {section === 'trading'      && <TradingSection />}
        {section === 'menu'         && <MenuSection />}
        {section === 'tableplan'    && <TablePlanSection />}
        {section === 'reports'      && <ReportsSection />}
        {section === 'bills'        && <BillsSection />}
        {section === 'zreport'      && <ZReportSection />}
        {section === 'staff'        && <StaffSection />}
        {section === 'customers'    && <CustomersSection />}
        {section === 'campaigns'    && <CampaignsSection />}
        {section === 'clock'        && <ClockRecordsSection />}
        {section === 'performance'  && <StaffPerformanceSection />}
        {section === 'vat'          && <VATReportSection />}
        {section === 'inventory'    && <InventorySection />}
        {section === 'allergens'    && <AllergenSection />}
        {section === 'settings'     && <SettingsSection />}
        {section === 'reservations' && <ReservationSettingsSection />}
      </div>
    </div>
  );
}
