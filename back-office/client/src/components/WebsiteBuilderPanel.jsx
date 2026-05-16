import { useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { C, card, btn, input, label } from '../theme.js';
import { generateWebsiteHtml, generateMultiPageWebsite, compressImage, TEMPLATES } from '../lib/websiteTemplate.js';
import { api } from '../api.js';

// ── Colour presets ────────────────────────────────────────────────────────────
const PRESETS = [
  { key: 'burgundy', label: 'Burgundy', primary: '#7B1C2D', accent: '#C49030' },
  { key: 'sage',     label: 'Sage',     primary: '#3F5B3C', accent: '#D9B36C' },
  { key: 'midnight', label: 'Midnight', primary: '#1B2A4E', accent: '#E0BE5A' },
  { key: 'charcoal', label: 'Charcoal', primary: '#1F2937', accent: '#D4A574' },
  { key: 'ivory',    label: 'Ivory',    primary: '#8B4513', accent: '#D4B896' },
  { key: 'forest',   label: 'Forest',   primary: '#14532D', accent: '#D4A574' },
  { key: 'plum',     label: 'Plum',     primary: '#4A0E4E', accent: '#D4A574' },
  { key: 'sunset',   label: 'Sunset',   primary: '#B45309', accent: '#FCD34D' },
  { key: 'plern',    label: 'Plern',    primary: '#25221E', accent: '#A88458' },
];

const DEFAULT_WIDGET_BASE = 'https://restaurant-epos-production.up.railway.app';

const PHOTO_SLOTS = [
  { key: 'photo_hero',      label: 'Hero photo',       hint: 'Top-of-page banner. Wide landscape works best.' },
  { key: 'photo_story',     label: 'Story photo',      hint: 'Shown next to your About text.' },
  { key: 'photo_gallery_1', label: 'Gallery 1', hint: '' },
  { key: 'photo_gallery_2', label: 'Gallery 2', hint: '' },
  { key: 'photo_gallery_3', label: 'Gallery 3', hint: '' },
  { key: 'photo_gallery_4', label: 'Gallery 4', hint: '' },
  { key: 'photo_gallery_5', label: 'Gallery 5', hint: '' },
  { key: 'photo_gallery_6', label: 'Gallery 6', hint: '' },
];

const EMPTY_SECTIONS = {
  story_enabled:    true,
  gallery_enabled:  true,

  // Stats bar
  stats_enabled: false,
  stats: [
    { value: '35+', label: 'Dishes' },
    { value: '4.9', label: 'Google' },
    { value: '£0',  label: 'Booking fee' },
    { value: '2019', label: 'Est.' },
  ],

  // Philosophy / brand manifesto
  philosophy_enabled: false,
  philosophy_eyebrow: 'The Philosophy',
  philosophy_title: '',
  philosophy_text: '',
  philosophy_quote: '',
  philosophy_quote_author: '',

  // Three pillars
  pillars_enabled: false,
  pillars_eyebrow: 'What Sets Us Apart',
  pillars: [
    { title: '', text: '' },
    { title: '', text: '' },
    { title: '', text: '' },
  ],

  // The Method / How we work
  method_enabled: false,
  method_title: 'The Method',
  method_intro: '',
  method_steps: [
    { zone: 'Zone 01', title: '', text: '' },
    { zone: 'Zone 02', title: '', text: '' },
    { zone: 'Zone 03', title: '', text: '' },
  ],

  hours_enabled: false, hours_text: '',
  press_enabled: false, press_items: [],
  catering_enabled: false, catering_text: '', catering_photo: '',
  booking_widget_enabled:  false,
  takeaway_widget_enabled: false,
  widget_base_url: DEFAULT_WIDGET_BASE,
  menu_enabled: false, menu_items: [],
  team_enabled: false, team_members: [],

  // Social links
  instagram_url: '',
  facebook_url: '',
  tripadvisor_url: '',

  seo_title: '', seo_description: '', seo_og_image: '',
  ga_id: '', fb_pixel_id: '',
};

const EMPTY = {
  restaurant_name: '', tagline: '', address: '', phone: '', email: '',
  about_text: '', primary_colour: '#7B1C2D', accent_colour: '#C49030',
  photo_hero: '', photo_story: '', logo_url: '',
  photo_gallery_1: '', photo_gallery_2: '', photo_gallery_3: '',
  photo_gallery_4: '', photo_gallery_5: '', photo_gallery_6: '',
  template: 'classic',
  sections: { ...EMPTY_SECTIONS },
};

export default function WebsiteBuilderPanel({ scope }) {
  const [cfg, setCfg]         = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [aiUrl, setAiUrl]     = useState('');
  const [aiBusy, setAiBusy]   = useState(false);
  const [aiErr, setAiErr]     = useState('');
  const [downloading, setDownloading] = useState(false);

  // ── Load ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const row = scope.kind === 'global'
          ? await api.getGlobalWebsite()
          : await api.getClientWebsite(scope.clientId);
        if (cancelled) return;
        const merged = { ...EMPTY };
        for (const k of Object.keys(EMPTY)) {
          if (k === 'sections') continue;
          merged[k] = row[k] ?? scope.defaults?.[k] ?? EMPTY[k];
        }
        merged.sections = { ...EMPTY_SECTIONS, ...(row.sections || {}) };
        // Ensure nested arrays have defaults
        if (!merged.sections.stats || !merged.sections.stats.length)
          merged.sections.stats = EMPTY_SECTIONS.stats;
        if (!merged.sections.pillars || !merged.sections.pillars.length)
          merged.sections.pillars = EMPTY_SECTIONS.pillars;
        if (!merged.sections.method_steps || !merged.sections.method_steps.length)
          merged.sections.method_steps = EMPTY_SECTIONS.method_steps;
        setCfg(merged);
      } catch (e) {
        console.error('[website-builder] load error', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scope.kind, scope.clientId]);

  const set = (k, v) => setCfg(prev => ({ ...prev, [k]: v }));
  const setSection = (k, v) => setCfg(prev => ({ ...prev, sections: { ...prev.sections, [k]: v } }));

  // ── Auto-save (1.2s debounce) ─────────────────────────────────────
  const dirtyRef    = useRef(false);
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    if (loading) return;
    dirtyRef.current = true;
    const handle = setTimeout(async () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setSaving(true);
      try {
        if (scope.kind === 'global') await api.saveGlobalWebsite(cfg);
        else                          await api.saveClientWebsite(scope.clientId, cfg);
        setSavedAt(new Date());
      } catch (e) { console.error('[website-builder] save error', e); }
      finally { setSaving(false); }
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  // ── AI import ─────────────────────────────────────────────────────
  const runAiImport = async () => {
    if (!aiUrl.trim()) return;
    setAiBusy(true); setAiErr('');
    try {
      const r = await api.aiImportWebsite(aiUrl.trim());
      const d = r.data || {};
      setCfg(prev => ({
        ...prev,
        restaurant_name: d.restaurant_name || prev.restaurant_name,
        tagline:         d.tagline         || prev.tagline,
        address:         d.address         || prev.address,
        phone:           d.phone           || prev.phone,
        email:           d.email           || prev.email,
        about_text:      d.about_text      || prev.about_text,
      }));
    } catch (e) { setAiErr(e.message); }
    finally { setAiBusy(false); }
  };

  // ── Photo upload ──────────────────────────────────────────────────
  const handleFile = async (slotKey, file) => {
    if (!file || !file.type.startsWith('image/')) return;
    try { set(slotKey, await compressImage(file)); }
    catch (e) { alert('Failed to read image: ' + e.message); }
  };

  // ── Live preview ──────────────────────────────────────────────────
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewPage, setPreviewPage] = useState('index.html');
  useEffect(() => {
    const handle = setTimeout(() => {
      const pages = generateMultiPageWebsite(cfg);
      setPreviewHtml(pages[previewPage] || pages['index.html']);
    }, 400);
    return () => clearTimeout(handle);
  }, [cfg, previewPage]);

  // ── Preview in new tab ────────────────────────────────────────────
  const openPreview = () => {
    const pages = generateMultiPageWebsite(cfg);
    const w = window.open('', '_blank');
    if (w) { w.document.write(pages[previewPage] || pages['index.html']); w.document.close(); }
  };

  // ── ZIP download ──────────────────────────────────────────────────
  const downloadZip = async () => {
    setDownloading(true);
    try {
      const pages = generateMultiPageWebsite(cfg);
      const zip   = new JSZip();
      const folder = zip.folder('website');
      for (const [filename, html] of Object.entries(pages)) {
        folder.file(filename, html);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const slug = (cfg.restaurant_name || 'restaurant')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      a.href = url;
      a.download = `${slug || 'restaurant'}-website.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Download failed: ' + e.message);
    } finally {
      setDownloading(false);
    }
  };

  if (loading) return (
    <div style={{ color: C.textMuted, padding: 40, textAlign: 'center' }}>Loading website config…</div>
  );

  return (
    <div>
      {/* ── Toolbar ── */}
      <div style={{ ...card, padding: 16, marginBottom: 18, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flex: 1, minWidth: 260, gap: 8 }}>
          <input
            value={aiUrl}
            onChange={e => setAiUrl(e.target.value)}
            placeholder="Paste existing restaurant URL to auto-fill…"
            style={{ ...input, flex: 1 }}
            onKeyDown={e => e.key === 'Enter' && runAiImport()}
          />
          <button onClick={runAiImport} disabled={aiBusy || !aiUrl.trim()} style={{ ...btn.primary, opacity: aiBusy ? 0.6 : 1 }}>
            {aiBusy ? 'Reading…' : '✨ AI import'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: C.textMuted }}>
          {saving ? 'Saving…' : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : 'Changes auto-save'}
        </div>
        <button onClick={openPreview} style={btn.ghost}>Preview</button>
        <button onClick={downloadZip} disabled={downloading} style={{ ...btn.gold, opacity: downloading ? 0.6 : 1 }}>
          {downloading ? 'Zipping…' : '⬇ Download ZIP'}
        </button>
      </div>

      {aiErr && (
        <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, border: `1px solid ${C.danger}33` }}>
          {aiErr}
        </div>
      )}

      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14, padding: '8px 14px', background: `${C.navy}08`, borderRadius: 8, border: `1px solid ${C.border}` }}>
        📄 The download creates a <strong>ZIP with 4 pages</strong>: Home · Menu · About · Contact — all sharing the same theme and nav.
      </div>

      {/* ── Two-pane layout ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 18 }}>

        {/* ── Left: form ── */}
        <div style={{ display: 'grid', gap: 18 }}>

          {/* Template */}
          <Section title="Template">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 10 }}>
              {Object.entries(TEMPLATES).map(([key, t]) => {
                const active = (cfg.template || 'classic') === key;
                return (
                  <button key={key} onClick={() => set('template', key)} style={{
                    padding: 12, borderRadius: 10, textAlign: 'left',
                    border: `2px solid ${active ? C.navy : C.border}`,
                    background: active ? `${C.navy}08` : 'white',
                    cursor: 'pointer', fontFamily: 'inherit',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t.label}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.4 }}>{t.description}</div>
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Identity */}
          <Section title="Identity">
            <Field label="Restaurant name">
              <input value={cfg.restaurant_name} onChange={e => set('restaurant_name', e.target.value)} style={input} />
            </Field>
            <Field label="Tagline">
              <input value={cfg.tagline} onChange={e => set('tagline', e.target.value)} style={input} placeholder="Authentic Thai cuisine in the heart of London" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label="Phone">
                <input value={cfg.phone} onChange={e => set('phone', e.target.value)} style={input} placeholder="020 1234 5678" />
              </Field>
              <Field label="Email">
                <input value={cfg.email} onChange={e => set('email', e.target.value)} style={input} placeholder="hello@…" />
              </Field>
            </div>
            <Field label="Address">
              <textarea value={cfg.address} onChange={e => set('address', e.target.value)} style={{ ...input, minHeight: 60, resize: 'vertical' }} />
            </Field>
          </Section>

          {/* Stats bar */}
          <Section
            title="Stats bar"
            toggle={{ enabled: !!cfg.sections.stats_enabled, onChange: v => setSection('stats_enabled', v) }}
          >
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
              Four bold numbers shown in a dark band — e.g. "35+ Dishes · 4.9 Google · £0 Booking fee · Est. 2019"
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {(cfg.sections.stats || EMPTY_SECTIONS.stats).map((st, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input
                    value={st.value}
                    onChange={e => {
                      const next = cfg.sections.stats.slice();
                      next[i] = { ...next[i], value: e.target.value };
                      setSection('stats', next);
                    }}
                    placeholder="35+"
                    style={{ ...input, width: 70 }}
                  />
                  <input
                    value={st.label}
                    onChange={e => {
                      const next = cfg.sections.stats.slice();
                      next[i] = { ...next[i], label: e.target.value };
                      setSection('stats', next);
                    }}
                    placeholder="Dishes"
                    style={{ ...input, flex: 1 }}
                  />
                </div>
              ))}
            </div>
          </Section>

          {/* Philosophy */}
          <Section
            title="Philosophy / Brand manifesto"
            toggle={{ enabled: !!cfg.sections.philosophy_enabled, onChange: v => setSection('philosophy_enabled', v) }}
          >
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
              A centred section with your restaurant's soul — like Plern's "The Plern State" concept block.
            </div>
            <Field label="Eyebrow label (small text above the title)">
              <input value={cfg.sections.philosophy_eyebrow || ''} onChange={e => setSection('philosophy_eyebrow', e.target.value)} style={input} placeholder="The Philosophy" />
            </Field>
            <Field label="Title">
              <input value={cfg.sections.philosophy_title || ''} onChange={e => setSection('philosophy_title', e.target.value)} style={input} placeholder="The Plern State" />
            </Field>
            <Field label="Body text">
              <textarea
                value={cfg.sections.philosophy_text || ''}
                onChange={e => setSection('philosophy_text', e.target.value)}
                style={{ ...input, minHeight: 100, resize: 'vertical' }}
                placeholder="Plern is the Thai word for being so absorbed by a moment that time itself slows…"
              />
            </Field>
            <Field label="Pull quote (optional — shown in a styled block)">
              <textarea
                value={cfg.sections.philosophy_quote || ''}
                onChange={e => setSection('philosophy_quote', e.target.value)}
                style={{ ...input, minHeight: 70, resize: 'vertical' }}
                placeholder="We are not just selling food — we are selling a pause button."
              />
            </Field>
            <Field label="Quote attribution (optional)">
              <input value={cfg.sections.philosophy_quote_author || ''} onChange={e => setSection('philosophy_quote_author', e.target.value)} style={input} placeholder="Plern Founding Principle" />
            </Field>
          </Section>

          {/* Three Pillars */}
          <Section
            title="Three pillars / USPs"
            toggle={{ enabled: !!cfg.sections.pillars_enabled, onChange: v => setSection('pillars_enabled', v) }}
          >
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
              Three numbered cards highlighting what makes the restaurant special.
            </div>
            <Field label="Section eyebrow">
              <input value={cfg.sections.pillars_eyebrow || ''} onChange={e => setSection('pillars_eyebrow', e.target.value)} style={input} placeholder="What Sets Us Apart" />
            </Field>
            {(cfg.sections.pillars || EMPTY_SECTIONS.pillars).map((p, i) => (
              <div key={i} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Pillar 0{i + 1}</div>
                <input
                  value={p.title || ''}
                  onChange={e => {
                    const next = (cfg.sections.pillars || []).slice();
                    next[i] = { ...next[i], title: e.target.value };
                    setSection('pillars', next);
                  }}
                  placeholder={['Modernist Kitchen', 'The Clean Kitchen', 'Storytelling on a Plate'][i] || 'Title'}
                  style={input}
                />
                <textarea
                  value={p.text || ''}
                  onChange={e => {
                    const next = (cfg.sections.pillars || []).slice();
                    next[i] = { ...next[i], text: e.target.value };
                    setSection('pillars', next);
                  }}
                  placeholder="Short description of this pillar…"
                  style={{ ...input, minHeight: 72, resize: 'vertical', fontSize: 13 }}
                />
              </div>
            ))}
          </Section>

          {/* About / Story */}
          <Section
            title="About / Story"
            toggle={{ enabled: cfg.sections.story_enabled !== false, onChange: v => setSection('story_enabled', v) }}
          >
            <Field label="About text (2–3 sentences in the restaurant's voice)">
              <textarea value={cfg.about_text} onChange={e => set('about_text', e.target.value)} style={{ ...input, minHeight: 120, resize: 'vertical' }} />
            </Field>
            <div style={{ fontSize: 11, color: C.textFaint }}>The story photo is in the Photos section below.</div>
          </Section>

          {/* The Method */}
          <Section
            title="The Method / How it works"
            toggle={{ enabled: !!cfg.sections.method_enabled, onChange: v => setSection('method_enabled', v) }}
          >
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
              Three numbered steps in a dark band — great for concept restaurants explaining their kitchen or service philosophy.
            </div>
            <Field label="Section title">
              <input value={cfg.sections.method_title || ''} onChange={e => setSection('method_title', e.target.value)} style={input} placeholder="The Method" />
            </Field>
            <Field label="Intro paragraph (optional)">
              <textarea value={cfg.sections.method_intro || ''} onChange={e => setSection('method_intro', e.target.value)} style={{ ...input, minHeight: 70, resize: 'vertical' }} placeholder="A short intro explaining the system…" />
            </Field>
            {(cfg.sections.method_steps || EMPTY_SECTIONS.method_steps).map((st, i) => (
              <div key={i} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, display: 'grid', gap: 8 }}>
                <input
                  value={st.zone || ''}
                  onChange={e => {
                    const next = (cfg.sections.method_steps || []).slice();
                    next[i] = { ...next[i], zone: e.target.value };
                    setSection('method_steps', next);
                  }}
                  placeholder={`Zone 0${i + 1}`}
                  style={{ ...input, fontSize: 12 }}
                />
                <input
                  value={st.title || ''}
                  onChange={e => {
                    const next = (cfg.sections.method_steps || []).slice();
                    next[i] = { ...next[i], title: e.target.value };
                    setSection('method_steps', next);
                  }}
                  placeholder={['The Prep', 'The Cook', 'The Finish'][i] || 'Step title'}
                  style={input}
                />
                <textarea
                  value={st.text || ''}
                  onChange={e => {
                    const next = (cfg.sections.method_steps || []).slice();
                    next[i] = { ...next[i], text: e.target.value };
                    setSection('method_steps', next);
                  }}
                  placeholder="What happens in this step…"
                  style={{ ...input, minHeight: 60, resize: 'vertical', fontSize: 13 }}
                />
              </div>
            ))}
          </Section>

          {/* Hours */}
          <Section
            title="Hours"
            toggle={{ enabled: !!cfg.sections.hours_enabled, onChange: v => setSection('hours_enabled', v) }}
          >
            <Field label="Opening hours (one line per day)">
              <textarea
                value={cfg.sections.hours_text || ''}
                onChange={e => setSection('hours_text', e.target.value)}
                placeholder={'Mon – Fri  11:00 – 22:00\nSat – Sun  12:00 – 23:00'}
                style={{ ...input, minHeight: 110, resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
              />
            </Field>
          </Section>

          {/* Press */}
          <Section
            title="In the press"
            toggle={{ enabled: !!cfg.sections.press_enabled, onChange: v => setSection('press_enabled', v) }}
          >
            <PressEditor items={cfg.sections.press_items || []} onChange={items => setSection('press_items', items)} />
          </Section>

          {/* Widgets */}
          <Section title="Online ordering &amp; booking widgets">
            <div style={{ display: 'grid', gap: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: C.text, fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!cfg.sections.booking_widget_enabled} onChange={e => setSection('booking_widget_enabled', e.target.checked)} style={{ width: 16, height: 16 }} />
                Embed the SiamEPOS booking widget
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: C.text, fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!cfg.sections.takeaway_widget_enabled} onChange={e => setSection('takeaway_widget_enabled', e.target.checked)} style={{ width: 16, height: 16 }} />
                Embed the online takeaway widget
              </label>
              <Field label="Widget backend URL">
                <input
                  value={cfg.sections.widget_base_url || ''}
                  onChange={e => setSection('widget_base_url', e.target.value)}
                  placeholder={DEFAULT_WIDGET_BASE}
                  style={{ ...input, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                />
              </Field>
            </div>
          </Section>

          {/* Catering */}
          <Section
            title="Catering &amp; events"
            toggle={{ enabled: !!cfg.sections.catering_enabled, onChange: v => setSection('catering_enabled', v) }}
          >
            <Field label="Catering pitch">
              <textarea
                value={cfg.sections.catering_text || ''}
                onChange={e => setSection('catering_text', e.target.value)}
                placeholder="Authentic Thai canapés and family-style platters for private events…"
                style={{ ...input, minHeight: 100, resize: 'vertical' }}
              />
            </Field>
            <PhotoSlot
              slot={{ key: 'catering_photo', label: 'Catering photo', hint: 'Shown alongside the catering pitch.' }}
              value={cfg.sections.catering_photo || ''}
              onChange={v => setSection('catering_photo', v)}
              onFile={async f => {
                if (!f || !f.type.startsWith('image/')) return;
                try { setSection('catering_photo', await compressImage(f)); }
                catch (e) { alert('Failed to read image: ' + e.message); }
              }}
            />
          </Section>

          {/* Theme colours */}
          <Section title="Theme colours">
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
              {PRESETS.map(p => {
                const active = cfg.primary_colour === p.primary && cfg.accent_colour === p.accent;
                return (
                  <button key={p.key}
                    onClick={() => { set('primary_colour', p.primary); set('accent_colour', p.accent); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7, padding: '7px 12px',
                      border: `2px solid ${active ? p.primary : C.border}`, borderRadius: 999,
                      background: active ? `${p.primary}10` : 'white', cursor: 'pointer',
                      fontWeight: 700, fontSize: 12, color: C.text,
                    }}>
                    <span style={{ width: 16, height: 16, borderRadius: 16, background: p.primary, border: `2px solid ${p.accent}`, flexShrink: 0 }} />
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <ColourField label="Primary" value={cfg.primary_colour} onChange={v => set('primary_colour', v)} />
              <ColourField label="Accent"  value={cfg.accent_colour}  onChange={v => set('accent_colour', v)} />
            </div>
          </Section>

          {/* Photos */}
          <Section
            title="Photos &amp; Gallery"
            toggle={{ label: 'Show gallery section', enabled: cfg.sections.gallery_enabled !== false, onChange: v => setSection('gallery_enabled', v) }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <PhotoSlot
                slot={{ key: 'logo_url', label: 'Logo (optional)', hint: 'Shown in nav. Square or wide-rectangle works best.' }}
                value={cfg.logo_url || ''}
                onChange={v => set('logo_url', v)}
                onFile={f => handleFile('logo_url', f)}
              />
              {PHOTO_SLOTS.map(slot => (
                <PhotoSlot key={slot.key} slot={slot} value={cfg[slot.key] || ''}
                  onChange={v => set(slot.key, v)} onFile={f => handleFile(slot.key, f)} />
              ))}
            </div>
          </Section>

          {/* Featured dishes */}
          <Section
            title="Featured dishes"
            toggle={{ enabled: !!cfg.sections.menu_enabled, onChange: v => setSection('menu_enabled', v) }}
          >
            <FeaturedMenuEditor scope={scope} items={cfg.sections.menu_items || []} onChange={items => setSection('menu_items', items)} />
          </Section>

          {/* Team */}
          <Section
            title="Meet the team"
            toggle={{ enabled: !!cfg.sections.team_enabled, onChange: v => setSection('team_enabled', v) }}
          >
            <TeamEditor
              members={cfg.sections.team_members || []}
              onChange={team => setSection('team_members', team)}
              onFile={async (i, file) => {
                if (!file) return;
                try {
                  const url = await compressImage(file);
                  const next = (cfg.sections.team_members || []).slice();
                  next[i] = { ...next[i], photo: url };
                  setSection('team_members', next);
                } catch (e) { alert('Failed to read image: ' + e.message); }
              }}
            />
          </Section>

          {/* Social */}
          <Section title="Social links">
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>Links appear in the footer. Leave blank to hide.</div>
            <Field label="Instagram URL"><input value={cfg.sections.instagram_url || ''} onChange={e => setSection('instagram_url', e.target.value)} style={input} placeholder="https://instagram.com/yourrestaurant" /></Field>
            <Field label="Facebook URL"><input value={cfg.sections.facebook_url || ''} onChange={e => setSection('facebook_url', e.target.value)} style={input} placeholder="https://facebook.com/yourrestaurant" /></Field>
            <Field label="TripAdvisor URL"><input value={cfg.sections.tripadvisor_url || ''} onChange={e => setSection('tripadvisor_url', e.target.value)} style={input} placeholder="https://tripadvisor.co.uk/…" /></Field>
          </Section>

          {/* SEO */}
          <Section title="SEO &amp; social preview">
            <Field label="Page title">
              <input value={cfg.sections.seo_title || ''} onChange={e => setSection('seo_title', e.target.value)} placeholder={cfg.restaurant_name || 'Restaurant'} style={input} />
            </Field>
            <Field label="Meta description (150–160 chars)">
              <textarea
                value={cfg.sections.seo_description || ''}
                onChange={e => setSection('seo_description', e.target.value)}
                maxLength={200}
                placeholder={cfg.tagline || ''}
                style={{ ...input, minHeight: 60, resize: 'vertical' }}
              />
              <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{(cfg.sections.seo_description || '').length} / 160</div>
            </Field>
            <PhotoSlot
              slot={{ key: 'seo_og_image', label: 'Social share image (optional)', hint: '1200×630 works best. Defaults to hero photo.' }}
              value={cfg.sections.seo_og_image || ''}
              onChange={v => setSection('seo_og_image', v)}
              onFile={async f => {
                if (!f) return;
                try { setSection('seo_og_image', await compressImage(f)); } catch (e) { alert(e.message); }
              }}
            />
          </Section>

          {/* Analytics */}
          <Section title="Analytics">
            <Field label="Google Analytics 4 ID">
              <input value={cfg.sections.ga_id || ''} onChange={e => setSection('ga_id', e.target.value.trim())} placeholder="G-XXXXXXXXXX" style={{ ...input, fontFamily: 'ui-monospace, monospace' }} />
            </Field>
            <Field label="Facebook Pixel ID">
              <input value={cfg.sections.fb_pixel_id || ''} onChange={e => setSection('fb_pixel_id', e.target.value.trim())} placeholder="1234567890123456" style={{ ...input, fontFamily: 'ui-monospace, monospace' }} />
            </Field>
          </Section>
        </div>

        {/* ── Right: live preview ── */}
        <PreviewPane previewHtml={previewHtml} previewPage={previewPage} setPreviewPage={setPreviewPage} />
      </div>
    </div>
  );
}

// ── Preview pane ──────────────────────────────────────────────────────────────
function PreviewPane({ previewHtml, previewPage, setPreviewPage }) {
  const [viewport, setViewport] = useState('desktop');
  const isMobile = viewport === 'mobile';
  const pages = [
    { key: 'index.html',   label: 'Home' },
    { key: 'menu.html',    label: 'Menu' },
    { key: 'about.html',   label: 'About' },
    { key: 'contact.html', label: 'Contact' },
  ];

  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden', position: 'sticky', top: 16, alignSelf: 'start', height: 'calc(100vh - 64px)' }}>
      {/* toolbar */}
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {/* page tabs */}
        <div style={{ display: 'flex', background: 'white', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
          {pages.map(p => (
            <button key={p.key} onClick={() => setPreviewPage(p.key)} style={pageBtn(previewPage === p.key)}>
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {/* viewport toggle */}
        <div style={{ display: 'flex', background: 'white', border: `1px solid ${C.border}`, borderRadius: 6, overflow: 'hidden' }}>
          <button onClick={() => setViewport('desktop')} style={vpBtn(!isMobile)}>🖥</button>
          <button onClick={() => setViewport('mobile')}  style={vpBtn(isMobile)}>📱</button>
        </div>
      </div>

      <div style={{ width: '100%', height: 'calc(100% - 44px)', overflow: 'auto', background: C.borderSoft, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: isMobile ? 16 : 0 }}>
        <iframe
          key={previewPage}
          title="Website preview"
          srcDoc={previewHtml}
          sandbox="allow-same-origin allow-scripts"
          style={{
            width:     isMobile ? 375 : '100%',
            maxWidth:  isMobile ? 375 : 'none',
            height:    isMobile ? 667 : '100%',
            border:    isMobile ? `1px solid ${C.border}` : 'none',
            borderRadius: isMobile ? 20 : 0,
            background: 'white',
            boxShadow:  isMobile ? '0 8px 32px rgba(0,0,0,0.18)' : 'none',
          }}
        />
      </div>
    </div>
  );
}

function pageBtn(active) {
  return {
    background: active ? C.navy : 'white',
    color:      active ? C.gold : '#475569',
    border: 'none', padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
  };
}
function vpBtn(active) {
  return {
    background: active ? C.navy : 'white',
    color:      active ? C.gold : '#475569',
    border: 'none', padding: '5px 9px', fontSize: 12, fontWeight: 800, cursor: 'pointer',
  };
}

// ── Sub-editors ───────────────────────────────────────────────────────────────
function FeaturedMenuEditor({ scope, items, onChange }) {
  const [menu, setMenu]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  if (scope.kind !== 'client') {
    return <div style={{ color: C.textFaint, fontSize: 13 }}>Featured dishes pull from a tenant's live EPOS menu. Open this builder from a client's page to enable it.</div>;
  }

  const load = async () => {
    setLoading(true); setErr('');
    try {
      const r = await api.getClientMenuPreview(scope.clientId);
      setMenu(r.items || []);
    } catch (e) { setErr(e.message); setMenu([]); }
    finally { setLoading(false); }
  };

  const isPicked = id => items.some(it => it.id === id);
  const toggle   = it => {
    if (isPicked(it.id)) onChange(items.filter(x => x.id !== it.id));
    else if (items.length >= 12) alert('Max 12 featured dishes. Remove one first.');
    else onChange([...items, { id: it.id, name: it.name, price: it.price, photo: it.photo, description: it.description, category: it.category }]);
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button onClick={load} disabled={loading} style={btn.ghost}>
          {loading ? 'Loading…' : menu === null ? '↓ Pull from EPOS' : '↻ Refresh'}
        </button>
        <span style={{ fontSize: 12, color: C.textMuted }}>{items.length} / 12 selected</span>
      </div>
      {err && <div style={{ background: C.dangerBg, color: '#991b1b', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>{err}</div>}
      {menu && menu.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 8, maxHeight: 340, overflowY: 'auto', padding: 2 }}>
          {menu.map(m => {
            const picked = isPicked(m.id);
            return (
              <button key={m.id} onClick={() => toggle(m)} style={{
                background: picked ? '#dcfce7' : 'white', border: `2px solid ${picked ? '#22c55e' : C.border}`,
                borderRadius: 9, padding: 10, textAlign: 'left', cursor: 'pointer',
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{m.name}</div>
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{m.category} · £{m.price.toFixed(2)}</div>
              </button>
            );
          })}
        </div>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {items.map(it => (
            <span key={it.id} style={{ background: '#dcfce7', color: '#166534', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>
              {it.name} · £{Number(it.price).toFixed(2)}
              <button onClick={() => toggle(it)} style={{ background: 'transparent', border: 'none', color: '#166534', marginLeft: 6, cursor: 'pointer', fontWeight: 800 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamEditor({ members, onChange, onFile }) {
  const add    = () => onChange([...members, { name: '', role: '', bio: '', photo: '' }]);
  const update = (i, field, value) => { const next = members.slice(); next[i] = { ...next[i], [field]: value }; onChange(next); };
  const remove = i => onChange(members.filter((_, idx) => idx !== i));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {members.length === 0 && <div style={{ color: C.textFaint, fontSize: 12, padding: '8px 0' }}>No team members yet.</div>}
      {members.map((t, i) => (
        <div key={i} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, display: 'grid', gap: 10, gridTemplateColumns: '110px 1fr' }}>
          <PhotoSlot slot={{ key: `team_${i}`, label: 'Portrait', hint: '' }} value={t.photo || ''} onChange={v => update(i, 'photo', v)} onFile={f => onFile(i, f)} />
          <div style={{ display: 'grid', gap: 8 }}>
            <input value={t.name || ''} onChange={e => update(i, 'name', e.target.value)} placeholder="Name" style={input} />
            <input value={t.role || ''} onChange={e => update(i, 'role', e.target.value)} placeholder="Role" style={input} />
            <textarea value={t.bio || ''} onChange={e => update(i, 'bio', e.target.value)} placeholder="Short bio." style={{ ...input, minHeight: 56, resize: 'vertical', fontSize: 13 }} />
            <button onClick={() => remove(i)} style={{ ...btn.ghost, color: C.danger, fontSize: 12 }}>Remove</button>
          </div>
        </div>
      ))}
      <button onClick={add} style={{ ...btn.ghost, justifySelf: 'start' }}>+ Add team member</button>
    </div>
  );
}

function PressEditor({ items, onChange }) {
  const add    = () => onChange([...items, { source: '', quote: '', link: '' }]);
  const update = (i, field, value) => { const next = items.slice(); next[i] = { ...next[i], [field]: value }; onChange(next); };
  const remove = i => onChange(items.filter((_, idx) => idx !== i));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {items.length === 0 && <div style={{ color: C.textFaint, fontSize: 12, padding: '8px 0' }}>No press items yet.</div>}
      {items.map((p, i) => (
        <div key={i} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, display: 'grid', gap: 10 }}>
          <input value={p.source || ''} onChange={e => update(i, 'source', e.target.value)} placeholder="Source (e.g. Time Out London)" style={input} />
          <textarea value={p.quote || ''} onChange={e => update(i, 'quote', e.target.value)} placeholder="Pull quote." style={{ ...input, minHeight: 56, resize: 'vertical' }} />
          <input value={p.link || ''} onChange={e => update(i, 'link', e.target.value)} placeholder="Link to article (optional)" style={input} />
          <button onClick={() => remove(i)} style={{ ...btn.ghost, color: C.danger, fontSize: 12 }}>Remove</button>
        </div>
      ))}
      <button onClick={add} style={{ ...btn.ghost, justifySelf: 'start' }}>+ Add press item</button>
    </div>
  );
}

// ── Primitives ────────────────────────────────────────────────────────────────
function Section({ title, children, toggle }) {
  const hidden = toggle && !toggle.enabled;
  return (
    <div style={{ ...card, padding: 20, opacity: hidden ? 0.65 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 12, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, flex: 1 }}>
          <span dangerouslySetInnerHTML={{ __html: title }} />
        </h3>
        {toggle && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: C.textMuted, fontWeight: 700 }}>
            <input type="checkbox" checked={!!toggle.enabled} onChange={e => toggle.onChange(e.target.checked)} style={{ width: 15, height: 15, cursor: 'pointer' }} />
            {toggle.label || 'Include'}
          </label>
        )}
      </div>
      {!hidden && <div style={{ display: 'grid', gap: 14 }}>{children}</div>}
    </div>
  );
}

function Field({ label: lbl, children }) {
  return (
    <div>
      <label style={label}>{lbl}</label>
      {children}
    </div>
  );
}

function ColourField({ label: lbl, value, onChange }) {
  return (
    <Field label={lbl}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ width: 42, height: 36, padding: 0, border: `1px solid ${C.border}`, borderRadius: 7, background: 'transparent', cursor: 'pointer' }} />
        <input value={value} onChange={e => onChange(e.target.value)}
          style={{ ...input, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }} />
      </div>
    </Field>
  );
}

function PhotoSlot({ slot, value, onChange, onFile }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef();

  const onDrop = e => {
    e.preventDefault(); setDrag(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{slot.label}</div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        style={{
          aspectRatio: '4 / 3',
          border: `2px dashed ${drag ? C.info : value ? 'transparent' : C.border}`,
          borderRadius: 10,
          background: value ? `center/cover no-repeat url('${value}')` : C.surfaceAlt,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
          padding: 8, cursor: 'pointer', position: 'relative', overflow: 'hidden',
        }}>
        {!value && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.textFaint, fontSize: 12, textAlign: 'center', padding: 12 }}>
            {drag ? 'Drop to upload' : 'Click or drop an image'}
          </div>
        )}
        {value && (
          <button onClick={e => { e.stopPropagation(); onChange(''); }}
            style={{ background: 'rgba(0,0,0,0.65)', color: 'white', border: 'none', borderRadius: 6, padding: '4px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
            Remove
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
      </div>
      {slot.hint && <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{slot.hint}</div>}
    </div>
  );
}
