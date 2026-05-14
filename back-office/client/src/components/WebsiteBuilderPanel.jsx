import { useEffect, useMemo, useRef, useState } from 'react';
import { C, card, btn, input, label } from '../theme.js';
import { generateWebsiteHtml, compressImage } from '../lib/websiteTemplate.js';
import { api } from '../api.js';

// Three preset palettes — picking one updates both colour inputs.
const PRESETS = [
  { key: 'burgundy', label: 'Burgundy',  primary: '#7B1C2D', accent: '#C49030' },
  { key: 'sage',     label: 'Sage',      primary: '#3F5B3C', accent: '#D9B36C' },
  { key: 'midnight', label: 'Midnight',  primary: '#1B2A4E', accent: '#E0BE5A' },
];

const PHOTO_SLOTS = [
  { key: 'photo_hero',      label: 'Hero photo',       hint: 'Top-of-page banner. Wide landscape works best.' },
  { key: 'photo_story',     label: 'Story photo',      hint: 'Shown next to your About text.' },
  { key: 'photo_gallery_1', label: 'Gallery 1',        hint: '' },
  { key: 'photo_gallery_2', label: 'Gallery 2',        hint: '' },
  { key: 'photo_gallery_3', label: 'Gallery 3',        hint: '' },
];

// SEPOS-WEB-002 — default section toggles. Story + Gallery default to ON
// (preserves the original one-pager experience). Hours / Press / Catering
// are opt-in.
const EMPTY_SECTIONS = {
  story_enabled:    true,
  gallery_enabled:  true,
  hours_enabled:    false, hours_text: '',
  press_enabled:    false, press_items: [],
  catering_enabled: false, catering_text: '', catering_photo: '',
};

const EMPTY = {
  restaurant_name: '', tagline: '', address: '', phone: '', email: '',
  about_text: '', primary_colour: '#7B1C2D', accent_colour: '#C49030',
  photo_hero: '', photo_story: '',
  photo_gallery_1: '', photo_gallery_2: '', photo_gallery_3: '',
  sections: { ...EMPTY_SECTIONS },
};

export default function WebsiteBuilderPanel({ scope }) {
  // scope: { kind: 'global' } | { kind: 'client', clientId: N, defaults?: {...} }
  const [cfg, setCfg]         = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [aiUrl, setAiUrl]     = useState('');
  const [aiBusy, setAiBusy]   = useState(false);
  const [aiErr, setAiErr]     = useState('');

  // ── Load initial config ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const row = scope.kind === 'global'
          ? await api.getGlobalWebsite()
          : await api.getClientWebsite(scope.clientId);
        if (cancelled) return;
        // Use loaded row, falling back to scope defaults (e.g. the
        // client's restaurant_name) for fields that are blank.
        const merged = { ...EMPTY };
        for (const k of Object.keys(EMPTY)) {
          if (k === 'sections') continue;
          merged[k] = row[k] ?? scope.defaults?.[k] ?? EMPTY[k];
        }
        merged.sections = { ...EMPTY_SECTIONS, ...(row.sections || {}) };
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

  // Debounced auto-save (1.2s after last change).
  const dirtyRef = useRef(false);
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

  // ── AI import ──────────────────────────────────────────────
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

  // ── Photo upload ───────────────────────────────────────────
  const handleFile = async (slotKey, file) => {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const dataUrl = await compressImage(file);
      set(slotKey, dataUrl);
    } catch (e) { alert('Failed to read image: ' + e.message); }
  };

  // ── Live preview (debounced) ──────────────────────────────
  const [previewHtml, setPreviewHtml] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setPreviewHtml(generateWebsiteHtml(cfg)), 350);
    return () => clearTimeout(handle);
  }, [cfg]);

  const downloadHtml = () => {
    const html = generateWebsiteHtml(cfg);
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const slug = (cfg.restaurant_name || 'restaurant')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    a.href = url; a.download = `${slug || 'restaurant'}-website.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const openPreview = () => {
    const w = window.open('', '_blank');
    if (w) { w.document.write(generateWebsiteHtml(cfg)); w.document.close(); }
  };

  if (loading) return <div style={{ color: C.textMuted, padding: 40, textAlign: 'center' }}>Loading website config…</div>;

  return (
    <div>
      {/* Header — AI import + save status + generate */}
      <div style={{ ...card, padding: 18, marginBottom: 18, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flex: 1, minWidth: 280, gap: 8 }}>
          <input
            value={aiUrl}
            onChange={(e) => setAiUrl(e.target.value)}
            placeholder="Paste existing restaurant URL to auto-fill…"
            style={{ ...input, flex: 1 }}
            onKeyDown={(e) => e.key === 'Enter' && runAiImport()}
          />
          <button onClick={runAiImport} disabled={aiBusy || !aiUrl.trim()} style={{ ...btn.primary, opacity: aiBusy ? 0.6 : 1 }}>
            {aiBusy ? 'Reading…' : '✨ AI import'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: C.textMuted, minWidth: 130, textAlign: 'right' }}>
          {saving ? 'Saving…' : savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : 'Changes auto-save'}
        </div>
        <button onClick={openPreview} style={btn.ghost}>Preview</button>
        <button onClick={downloadHtml} style={btn.gold}>⬇ Download HTML</button>
      </div>

      {aiErr && (
        <div style={{ background: C.dangerBg, color: '#991b1b', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16, border: `1px solid ${C.danger}33` }}>
          {aiErr}
        </div>
      )}

      {/* Two-pane layout: form left, live preview right */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.05fr) minmax(0, 1fr)', gap: 18 }}>
        <div style={{ display: 'grid', gap: 18 }}>
          <Section title="Identity">
            <Field label="Restaurant name">
              <input value={cfg.restaurant_name} onChange={(e) => set('restaurant_name', e.target.value)} style={input} />
            </Field>
            <Field label="Tagline">
              <input value={cfg.tagline} onChange={(e) => set('tagline', e.target.value)} style={input} placeholder="Authentic Thai cuisine in the heart of London" />
            </Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Field label="Phone">
                <input value={cfg.phone} onChange={(e) => set('phone', e.target.value)} style={input} placeholder="020 1234 5678" />
              </Field>
              <Field label="Email">
                <input value={cfg.email} onChange={(e) => set('email', e.target.value)} style={input} placeholder="hello@…" />
              </Field>
            </div>
            <Field label="Address">
              <textarea value={cfg.address} onChange={(e) => set('address', e.target.value)} style={{ ...input, minHeight: 60, resize: 'vertical' }} />
            </Field>
          </Section>

          <Section
            title="About / Story"
            toggle={{ enabled: cfg.sections.story_enabled !== false, onChange: (v) => setSection('story_enabled', v) }}
          >
            <Field label="About text (2–3 sentences in the restaurant's voice)">
              <textarea value={cfg.about_text} onChange={(e) => set('about_text', e.target.value)}
                style={{ ...input, minHeight: 120, resize: 'vertical' }} />
            </Field>
            <div style={{ fontSize: 11, color: C.textFaint }}>
              The story photo is the second photo slot under "Photos" below.
            </div>
          </Section>

          <Section
            title="Hours"
            toggle={{ enabled: !!cfg.sections.hours_enabled, onChange: (v) => setSection('hours_enabled', v) }}
          >
            <Field label="Opening hours (one line per day)">
              <textarea
                value={cfg.sections.hours_text || ''}
                onChange={(e) => setSection('hours_text', e.target.value)}
                placeholder={'Mon – Fri  11:00 – 22:00\nSat – Sun  12:00 – 23:00'}
                style={{ ...input, minHeight: 110, resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
              />
            </Field>
          </Section>

          <Section
            title="In the press"
            toggle={{ enabled: !!cfg.sections.press_enabled, onChange: (v) => setSection('press_enabled', v) }}
          >
            <PressEditor
              items={cfg.sections.press_items || []}
              onChange={(items) => setSection('press_items', items)}
            />
          </Section>

          <Section
            title="Catering &amp; events"
            toggle={{ enabled: !!cfg.sections.catering_enabled, onChange: (v) => setSection('catering_enabled', v) }}
          >
            <Field label="Catering pitch">
              <textarea
                value={cfg.sections.catering_text || ''}
                onChange={(e) => setSection('catering_text', e.target.value)}
                placeholder="Authentic Thai canapés and family-style platters for private events…"
                style={{ ...input, minHeight: 100, resize: 'vertical' }}
              />
            </Field>
            <PhotoSlot
              slot={{ key: 'catering_photo', label: 'Catering photo', hint: 'Shown alongside the catering pitch.' }}
              value={cfg.sections.catering_photo || ''}
              onChange={(v) => setSection('catering_photo', v)}
              onFile={async (f) => {
                if (!f || !f.type.startsWith('image/')) return;
                try { setSection('catering_photo', await compressImage(f)); }
                catch (e) { alert('Failed to read image: ' + e.message); }
              }}
            />
          </Section>

          <Section title="Theme colours">
            <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
              {PRESETS.map(p => {
                const active = cfg.primary_colour === p.primary && cfg.accent_colour === p.accent;
                return (
                  <button key={p.key}
                    onClick={() => { set('primary_colour', p.primary); set('accent_colour', p.accent); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px',
                      border: `2px solid ${active ? p.primary : C.border}`, borderRadius: 999,
                      background: active ? `${p.primary}10` : 'white', cursor: 'pointer',
                      fontWeight: 700, fontSize: 13, color: C.text,
                    }}>
                    <span style={{ width: 18, height: 18, borderRadius: 18, background: p.primary, border: `2px solid ${p.accent}` }} />
                    {p.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <ColourField label="Primary" value={cfg.primary_colour} onChange={(v) => set('primary_colour', v)} />
              <ColourField label="Accent"  value={cfg.accent_colour}  onChange={(v) => set('accent_colour', v)} />
            </div>
          </Section>

          <Section
            title="Photos & Gallery"
            toggle={{
              label: 'Show gallery section',
              enabled: cfg.sections.gallery_enabled !== false,
              onChange: (v) => setSection('gallery_enabled', v),
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {PHOTO_SLOTS.map(slot => (
                <PhotoSlot key={slot.key} slot={slot} value={cfg[slot.key]}
                  onChange={(v) => set(slot.key, v)} onFile={(f) => handleFile(slot.key, f)} />
              ))}
            </div>
          </Section>
        </div>

        {/* Live preview */}
        <div style={{ ...card, padding: 0, overflow: 'hidden', position: 'sticky', top: 16, alignSelf: 'start', height: 'calc(100vh - 64px)' }}>
          <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, background: C.surfaceAlt, fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            Live preview
          </div>
          <iframe
            title="Website preview"
            srcDoc={previewHtml}
            sandbox="allow-same-origin"
            style={{ width: '100%', height: 'calc(100% - 38px)', border: 'none', background: 'white' }}
          />
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, toggle }) {
  const hidden = toggle && !toggle.enabled;
  return (
    <div style={{ ...card, padding: 22, opacity: hidden ? 0.7 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 800, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, flex: 1 }}>
          <span dangerouslySetInnerHTML={{ __html: title }} />
        </h3>
        {toggle && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: C.textMuted, fontWeight: 700 }}>
            <input
              type="checkbox"
              checked={!!toggle.enabled}
              onChange={(e) => toggle.onChange(e.target.checked)}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            {toggle.label || 'Include'}
          </label>
        )}
      </div>
      {!hidden && <div style={{ display: 'grid', gap: 14 }}>{children}</div>}
    </div>
  );
}

function PressEditor({ items, onChange }) {
  const add = () => onChange([...items, { source: '', quote: '', link: '' }]);
  const update = (i, field, value) => {
    const next = items.slice();
    next[i] = { ...next[i], [field]: value };
    onChange(next);
  };
  const remove = (i) => onChange(items.filter((_, idx) => idx !== i));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {items.length === 0 && (
        <div style={{ color: C.textFaint, fontSize: 12, padding: '10px 0' }}>
          No press items yet. Click below to add one.
        </div>
      )}
      {items.map((p, i) => (
        <div key={i} style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12 }}>
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              value={p.source || ''}
              onChange={(e) => update(i, 'source', e.target.value)}
              placeholder="Source (e.g. Time Out London)"
              style={input}
            />
            <textarea
              value={p.quote || ''}
              onChange={(e) => update(i, 'quote', e.target.value)}
              placeholder="Pull quote — keep it short."
              style={{ ...input, minHeight: 60, resize: 'vertical' }}
            />
            <input
              value={p.link || ''}
              onChange={(e) => update(i, 'link', e.target.value)}
              placeholder="Link to article (optional)"
              style={input}
            />
            <button onClick={() => remove(i)} style={{ ...btn.ghost, color: C.danger, alignSelf: 'flex-end', fontSize: 12 }}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <button onClick={add} style={{ ...btn.ghost, justifySelf: 'start' }}>
        + Add press item
      </button>
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
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
          style={{ width: 44, height: 38, padding: 0, border: `1px solid ${C.border}`, borderRadius: 8, background: 'transparent', cursor: 'pointer' }} />
        <input value={value} onChange={(e) => onChange(e.target.value)}
          style={{ ...input, fontFamily: 'ui-monospace, monospace', textTransform: 'uppercase' }} />
      </div>
    </Field>
  );
}

function PhotoSlot({ slot, value, onChange, onFile }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef();

  const onDrop = (e) => {
    e.preventDefault(); setDrag(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  };

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{slot.label}</div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
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
          <button onClick={(e) => { e.stopPropagation(); onChange(''); }}
            style={{ background: 'rgba(0,0,0,0.65)', color: 'white', border: 'none', borderRadius: 6, padding: '4px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>Remove</button>
        )}
        <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      </div>
      {slot.hint && <div style={{ fontSize: 11, color: C.textFaint, marginTop: 4 }}>{slot.hint}</div>}
    </div>
  );
}
