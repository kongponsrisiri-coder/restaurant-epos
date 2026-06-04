import { useState, useEffect } from 'react';
import { canAccessAdminSection } from '../utils/plan';
import UpgradeLocked from '../components/UpgradeLocked';
import TradingSection   from './admin/TradingSection';
import MenuSection      from './admin/MenuSection';
import TablePlanSection from './admin/TablePlanSection';
import ReportsSection   from './admin/ReportsSection';
import BillsSection     from './admin/BillsSection';
import ZReportSection   from './admin/ZReportSection';
import StaffSection     from './admin/StaffSection';
import CustomersSection   from './admin/CustomersSection';
import VouchersSection    from './admin/VouchersSection';
import CampaignsSection   from './admin/CampaignsSection';
import ClockRecordsSection from './admin/ClockRecordsSection';
import StaffPerformanceSection from './admin/StaffPerformanceSection';
import VATReportSection from './admin/VATReportSection';
import AllergenSection  from './admin/AllergenSection';
import SettingsSection  from './admin/SettingsSection';
import PrintersSection  from './admin/PrintersSection';
import InventorySection from './admin/inventory/InventorySection';
import ReservationSettingsSection from './admin/ReservationSettingsSection';

// Sidebar layout — 4 collapsible groups so all 18 sections fit on
// smaller laptop screens. Headers toggle their group open/closed; the
// group containing the active section is force-opened. State persists
// in localStorage so the next session opens where the operator left it.
const GROUPS = [
  {
    title: 'OPERATIONS',
    items: [
      { id: 'trading',     label: '📊 Trading' },
      { id: 'menu',        label: '🍽️ Menu' },
      { id: 'tableplan',   label: '🗺️ Table Plan' },
      { id: 'inventory',   label: '🥬 Inventory' },
      { id: 'allergens',   label: '🌿 Allergens' },
    ],
  },
  {
    title: 'CUSTOMERS',
    items: [
      { id: 'customers',   label: '🧑‍🤝‍🧑 Customers' },
      { id: 'vouchers',    label: '🎁 Vouchers' },
      { id: 'campaigns',   label: '📧 Campaigns' },
    ],
  },
  {
    title: 'STAFF',
    items: [
      { id: 'staff',       label: '👥 Staff' },
      { id: 'clock',       label: '🕐 Clock Records' },
      { id: 'performance', label: '📊 Staff Performance' },
    ],
  },
  {
    title: 'REPORTS',
    items: [
      { id: 'reports',     label: '📈 Reports' },
      { id: 'bills',       label: '🧾 Bills' },
      { id: 'zreport',     label: '🔐 Z Report' },
      { id: 'vat',         label: '🧾 VAT Report' },
    ],
  },
  {
    title: 'SETTINGS',
    items: [
      { id: 'settings',    label: '⚙️ Settings' },
      { id: 'printers',    label: '🖨️ Printers' },
      { id: 'reservations', label: '📅 Reservations' },
    ],
  },
];

// Flat lookup used by the locked-section fallback + initial-landing
// selector — same shape as the original navItems array.
const ALL_ITEMS = GROUPS.flatMap(g => g.items);

const STORAGE_KEY = 'admin_sidebar_open_groups';

function readStoredOpen() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : null;
  } catch { return null; }
}

function groupContaining(sectionId) {
  return GROUPS.find(g => g.items.some(i => i.id === sectionId))?.title || null;
}

export default function AdminScreen({ plan }) {
  const [section, setSection] = useState('trading');

  // Default open groups: whatever was saved last, otherwise just the
  // group containing the initial section so the active item is visible.
  const [openGroups, setOpenGroups] = useState(() => {
    const stored = readStoredOpen();
    if (stored) return stored;
    const init = groupContaining('trading');
    return new Set(init ? [init] : []);
  });

  // SEPOS-LITE-002 — every section still shows in the sidebar; sections
  // the plan doesn't include are marked locked and open an upgrade panel.
  const allowed = (id) => canAccessAdminSection(plan, id);

  // Land on a section this plan can use — locked sections stay clickable
  // but shouldn't be the initial landing.
  useEffect(() => {
    if (!allowed(section)) {
      const first = ALL_ITEMS.find(i => allowed(i.id));
      setSection(first ? first.id : 'settings');
    }
  }, [plan]);

  // Whenever the active section changes, make sure its group is open
  // so the highlighted item is actually visible.
  useEffect(() => {
    const g = groupContaining(section);
    if (g && !openGroups.has(g)) {
      setOpenGroups(prev => {
        const next = new Set(prev);
        next.add(g);
        return next;
      });
    }
  }, [section]);

  // Persist whenever the open set changes.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...openGroups])); } catch {}
  }, [openGroups]);

  const toggleGroup = (title) => {
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title); else next.add(title);
      return next;
    });
  };

  const sectionLocked = !allowed(section);
  const lockedLabel = (ALL_ITEMS.find(i => i.id === section)?.label || 'This section')
    .split(' ').slice(1).join(' ');

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 60px)' }}>
      <div style={{ width: 200, background: '#1a1a2e', display: 'flex', flexDirection: 'column', padding: '20px 0', overflowY: 'auto' }}>
        <div style={{ color: 'white', fontWeight: 700, fontSize: 14, padding: '0 20px 16px', opacity: 0.5, textTransform: 'uppercase', letterSpacing: 1 }}>Admin Panel</div>
        {GROUPS.map(group => {
          const isOpen = openGroups.has(group.title);
          // Section header — clickable, shows chevron + count of items.
          return (
            <div key={group.title}>
              <button
                onClick={() => toggleGroup(group.title)}
                style={{
                  background: 'none', border: 'none',
                  color: 'white', opacity: 0.55,
                  padding: '10px 20px 6px', textAlign: 'left',
                  cursor: 'pointer', fontSize: 11, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: 1.2,
                  width: '100%',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <span>{group.title}</span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && group.items.map(item => {
                const locked = !allowed(item.id);
                return (
                  <button key={item.id} onClick={() => setSection(item.id)}
                    title={locked ? 'Not in your plan — upgrade to unlock' : undefined}
                    style={{ background: section === item.id ? '#e94560' : 'none', border: 'none', color: 'white', padding: '10px 20px 10px 28px', textAlign: 'left', cursor: 'pointer', fontSize: 14, fontWeight: section === item.id ? 700 : 400, opacity: locked ? 0.5 : 1, width: '100%' }}>
                    {item.label}{locked ? ' 🔒' : ''}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1, overflow: section === 'inventory' ? 'hidden' : 'auto', background: '#f5f5f5' }}>
        {sectionLocked ? (
          <UpgradeLocked feature={lockedLabel} />
        ) : (
          <>
            {section === 'trading'      && <TradingSection />}
            {section === 'menu'         && <MenuSection />}
            {section === 'tableplan'    && <TablePlanSection />}
            {section === 'reports'      && <ReportsSection />}
            {section === 'bills'        && <BillsSection />}
            {section === 'zreport'      && <ZReportSection />}
            {section === 'staff'        && <StaffSection />}
            {section === 'customers'    && <CustomersSection />}
            {section === 'vouchers'     && <VouchersSection />}
            {section === 'campaigns'    && <CampaignsSection />}
            {section === 'clock'        && <ClockRecordsSection />}
            {section === 'performance'  && <StaffPerformanceSection />}
            {section === 'vat'          && <VATReportSection />}
            {section === 'inventory'    && <InventorySection />}
            {section === 'allergens'    && <AllergenSection />}
            {section === 'printers'     && <PrintersSection />}
            {section === 'settings'     && <SettingsSection />}
            {section === 'reservations' && <ReservationSettingsSection />}
          </>
        )}
      </div>
    </div>
  );
}
