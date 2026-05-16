// SEPOS-WEB — multi-page restaurant website generator.
// generateMultiPageWebsite(cfg) returns { 'index.html', 'about.html', 'menu.html', 'contact.html' }
// Each file is self-contained HTML with inline CSS and base64 photos.

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// ── Templates ────────────────────────────────────────────────────────────────
// Five built-in design templates. Each tweaks typography + colours.
export const TEMPLATES = {
  classic: {
    label: 'Classic Thai',
    description: 'Warm Georgia serif, image-led — the original look.',
    headFont:  `Georgia, 'Times New Roman', serif`,
    bodyFont:  `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`,
    googleFonts: '',
    bg:        '#ffffff',
    altBg:     '#faf7f2',
    navBg:     'rgba(255,255,255,0.97)',
    navColor:  'var(--primary)',
    navLink:   '#444',
    footerBg:  'var(--primary-dark)',
    footerColor: 'rgba(255,255,255,0.78)',
    extraCss:  '',
  },
  modern: {
    label: 'Modern Minimal',
    description: 'Inter sans throughout, lots of whitespace, no fuss.',
    headFont:  `Inter, -apple-system, BlinkMacSystemFont, sans-serif`,
    bodyFont:  `Inter, -apple-system, BlinkMacSystemFont, sans-serif`,
    googleFonts: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap',
    bg:        '#ffffff',
    altBg:     '#ffffff',
    navBg:     'rgba(255,255,255,0.97)',
    navColor:  'var(--primary)',
    navLink:   '#444',
    footerBg:  '#1a1a1a',
    footerColor: 'rgba(255,255,255,0.7)',
    extraCss: `
      .section { padding: 100px 0; border-bottom: 1px solid #f0f0f0; }
      .section-alt { background: #ffffff; }
      .section h2 { text-align: left; font-weight: 800; letter-spacing: -0.5px; }
      .section h2::after { margin: 12px 0 0; width: 40px; }
      .nav { border-bottom: 1px solid #eee; }
      .hero h1 { font-weight: 800; letter-spacing: -1.5px; }
    `,
  },
  editorial: {
    label: 'Bold Editorial',
    description: 'Big Playfair Display headlines, magazine-style.',
    headFont:  `'Playfair Display', Georgia, serif`,
    bodyFont:  `'Source Sans 3', -apple-system, sans-serif`,
    googleFonts: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;800&family=Source+Sans+3:wght@400;600&display=swap',
    bg:        '#ffffff',
    altBg:     '#f9f5ee',
    navBg:     'rgba(255,255,255,0.97)',
    navColor:  'var(--primary)',
    navLink:   '#444',
    footerBg:  'var(--primary-dark)',
    footerColor: 'rgba(255,255,255,0.78)',
    extraCss: `
      .hero h1 { font-size: clamp(48px, 8vw, 88px); font-weight: 800; letter-spacing: -1px; line-height: 1; }
      .section h2 { font-size: 44px; font-weight: 800; }
      .section h2::after { width: 80px; height: 4px; }
    `,
  },
  boutique: {
    label: 'Boutique',
    description: 'Refined Cormorant heads, warm Lora body — fine-dining.',
    headFont:  `'Cormorant Garamond', Georgia, serif`,
    bodyFont:  `'Lora', Georgia, serif`,
    googleFonts: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;700&family=Lora:wght@400;600&display=swap',
    bg:        '#ffffff',
    altBg:     '#f3ece1',
    navBg:     'rgba(255,255,255,0.97)',
    navColor:  'var(--primary)',
    navLink:   '#444',
    footerBg:  'var(--primary-dark)',
    footerColor: 'rgba(255,255,255,0.78)',
    extraCss: `
      .hero h1 { font-weight: 500; font-style: italic; }
      .section h2 { font-weight: 500; font-style: italic; }
      .nav-brand { font-style: italic; }
      .about-text p { font-size: 17px; }
    `,
  },
  plern: {
    label: 'Plern Bistro',
    description: 'Cream & charcoal luxury. Cormorant editorial + Inter. Fine-dining prestige.',
    headFont:  `'Cormorant Garamond', Georgia, serif`,
    bodyFont:  `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`,
    googleFonts: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap',
    bg:        '#F4EBDC',
    altBg:     '#EFE3CF',
    navBg:     'rgba(37,34,30,0.97)',
    navColor:  '#F4EBDC',
    navLink:   'rgba(255,255,255,0.85)',
    footerBg:  '#25221E',
    footerColor: 'rgba(244,235,220,0.7)',
    extraCss: `
      body { background: #F4EBDC; color: #1A1916; }
      .nav { background: transparent; border: none; }
      .nav.scrolled { background: rgba(37,34,30,0.97) !important; }
      .nav-brand { color: #fff; letter-spacing: 2px; }
      .nav-links a { color: rgba(255,255,255,0.85); text-transform: uppercase; letter-spacing: 1px; font-size: 12px; }
      .nav-links a:hover { color: #C9A57A; }
      .nav-cta-btn { background: #A88458 !important; color: #25221E !important; }
      .hero { min-height: 100vh; }
      .hero h1 { font-size: clamp(52px, 9vw, 100px); font-weight: 300; letter-spacing: 4px; font-style: italic; }
      .hero p { font-family: 'Inter', sans-serif; letter-spacing: 3px; text-transform: uppercase; font-size: 13px; font-weight: 500; }
      .eyebrow { display: inline-block; font-family: 'Inter', sans-serif; font-size: 10px; letter-spacing: 5px; text-transform: uppercase; color: #A88458; font-weight: 600; margin-bottom: 16px; }
      .section h2 { font-size: clamp(36px, 5vw, 60px); font-weight: 400; letter-spacing: -0.5px; }
      .section h2::after { background: #A88458; }
      .philosophy-quote { border-left: 3px solid #A88458; padding-left: 20px; font-style: italic; font-size: 18px; color: #34302B; margin: 24px 0; font-family: 'Cormorant Garamond', serif; }
      .pillars-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 2px; background: #D4C9B4; }
      .pillar-card { background: #F4EBDC; padding: 40px 32px; }
      .pillar-num { font-family: 'Cormorant Garamond', serif; font-size: 48px; font-weight: 300; color: #A88458; line-height: 1; margin-bottom: 16px; }
      .stats-bar { background: #25221E; color: #F4EBDC; }
      .stat-value { font-family: 'Cormorant Garamond', serif; font-size: 52px; font-weight: 300; color: #C9A57A; }
      .stat-label { font-family: 'Inter', sans-serif; font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: rgba(244,235,220,0.6); }
      .method-zone { font-family: 'Inter', sans-serif; font-size: 10px; letter-spacing: 4px; text-transform: uppercase; color: #A88458; }
      .menu-card { background: #fff; border: 1px solid #E0D6C4; }
      .visit-card { background: #fff; border: 1px solid #E0D6C4; }
      .hours-card { background: #fff; border: 1px solid #E0D6C4; }
      footer a { color: #C9A57A; }
      .hero a.cta { background: #A88458; color: #25221E; }
      .hero a.cta:hover { background: #C9A57A; }
    `,
  },
};

// ── Colour helper ─────────────────────────────────────────────────────────────
function shade(hex, pct) {
  const n = (parseInt((hex || '#000000').replace('#', ''), 16) || 0);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const adj = c => Math.max(0, Math.min(255, Math.round(c + (pct < 0 ? c : (255 - c)) * pct)));
  r = adj(r); g = adj(g); b = adj(b);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// ── Shared nav + footer ───────────────────────────────────────────────────────
function makeNav(cfg, tpl, activePage = 'index') {
  const name   = escapeHtml(cfg.restaurant_name || 'Restaurant');
  const logoUrl = cfg.logo_url || '';
  const pages  = [
    { key: 'index',   label: 'Home',    file: 'index.html' },
    { key: 'menu',    label: 'Menu',    file: 'menu.html' },
    { key: 'about',   label: 'About',   file: 'about.html' },
    { key: 'contact', label: 'Contact', file: 'contact.html' },
  ];
  const s = cfg.sections || {};
  const links = pages.map(p => {
    const active = p.key === activePage ? 'style="color:var(--accent);"' : '';
    return `<a href="${p.file}" ${active}>${p.label}</a>`;
  }).join('');
  const bookLink = s.booking_widget_enabled ? `<a class="nav-cta-btn" href="index.html#book">Book</a>` : '';
  const orderLink = s.takeaway_widget_enabled ? `<a class="nav-cta-btn" href="index.html#order" style="margin-left:6px;background:transparent;border:1px solid currentColor;">Order</a>` : '';

  return `
  <nav class="nav" id="main-nav">
    <div class="nav-inner">
      <a class="nav-brand" href="index.html">
        ${logoUrl ? `<img class="nav-logo" src="${logoUrl}" alt="${name}" />` : ''}
        <span>${name}</span>
      </a>
      <button class="nav-toggle" onclick="document.getElementById('nav-menu').classList.toggle('open')" aria-label="Menu">☰</button>
      <div class="nav-links" id="nav-menu">
        ${links}
        ${bookLink}${orderLink}
      </div>
    </div>
  </nav>
  <script>
    (function(){
      var nav = document.getElementById('main-nav');
      window.addEventListener('scroll', function(){
        nav.classList.toggle('scrolled', window.scrollY > 40);
      });
    })();
  </script>`;
}

function makeFooter(cfg, tpl) {
  const name    = escapeHtml(cfg.restaurant_name || 'Restaurant');
  const phone   = escapeHtml(cfg.phone || '');
  const email   = escapeHtml(cfg.email || '');
  const address = escapeHtml(cfg.address || '');
  const s       = cfg.sections || {};
  const ig = s.instagram_url ? `<a href="${escapeHtml(s.instagram_url)}" target="_blank" rel="noopener">Instagram</a>` : '';
  const fb = s.facebook_url  ? `<a href="${escapeHtml(s.facebook_url)}"  target="_blank" rel="noopener">Facebook</a>`  : '';
  const ta = s.tripadvisor_url ? `<a href="${escapeHtml(s.tripadvisor_url)}" target="_blank" rel="noopener">TripAdvisor</a>` : '';
  const social = [ig, fb, ta].filter(Boolean).join(' · ');

  return `
  <footer>
    <div class="footer-inner">
      <div class="footer-brand">${name}</div>
      ${address ? `<div class="footer-address">${address.replace(/\n/g, ', ')}</div>` : ''}
      <div class="footer-contact">
        ${phone ? `<a href="tel:${phone}">${phone}</a>` : ''}
        ${phone && email ? ' · ' : ''}
        ${email ? `<a href="mailto:${email}">${email}</a>` : ''}
      </div>
      ${social ? `<div class="footer-social">${social}</div>` : ''}
      <div class="footer-copy">&copy; ${new Date().getFullYear()} ${name} &middot; <a href="https://siamepos.co.uk">Powered by SiamEPOS™</a></div>
    </div>
  </footer>`;
}

// ── Shared CSS ────────────────────────────────────────────────────────────────
function makeSharedCss(cfg, tpl) {
  const primary     = cfg.primary_colour || '#7B1C2D';
  const accent      = cfg.accent_colour  || '#C49030';
  const primaryDark = shade(primary, -0.25);

  return `
    :root { --primary: ${primary}; --primary-dark: ${primaryDark}; --accent: ${accent}; }
    *, *::before, *::after { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; font-family: ${tpl.bodyFont}; color: #1a1a1a; line-height: 1.65; background: ${tpl.bg}; -webkit-font-smoothing: antialiased; }
    h1, h2, h3, h4 { font-family: ${tpl.headFont}; line-height: 1.15; margin: 0 0 0.4em; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; color: var(--primary-dark); }
    img { max-width: 100%; display: block; }
    .container { max-width: 1140px; margin: 0 auto; padding: 0 28px; }
    .eyebrow { display: inline-block; font-size: 11px; letter-spacing: 4px; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 14px; }

    /* ── Nav ── */
    .nav { position: fixed; top: 0; left: 0; right: 0; z-index: 60; padding: 16px 0;
           background: ${tpl.navBg}; transition: background .3s, padding .3s, box-shadow .3s; }
    .nav.scrolled { padding: 10px 0; box-shadow: 0 4px 24px rgba(0,0,0,0.12); }
    .nav-inner { display: flex; align-items: center; justify-content: space-between; max-width: 1140px; margin: 0 auto; padding: 0 28px; gap: 16px; }
    .nav-brand { font-family: ${tpl.headFont}; font-weight: 700; font-size: 20px; color: ${tpl.navColor}; letter-spacing: 0.5px; display: inline-flex; align-items: center; gap: 10px; text-decoration: none; }
    .nav-brand:hover { text-decoration: none; color: ${tpl.navColor}; opacity: 0.85; }
    .nav-logo { height: 32px; width: auto; }
    .nav-links { display: flex; align-items: center; gap: 4px; }
    .nav-links a { color: ${tpl.navLink}; font-size: 13px; font-weight: 600; padding: 8px 12px; border-radius: 4px; text-decoration: none; }
    .nav-links a:hover { color: var(--accent); text-decoration: none; }
    .nav-cta-btn { background: var(--accent); color: #1a1a1a !important; padding: 9px 18px !important; border-radius: 6px; font-weight: 700 !important; font-size: 13px; margin-left: 8px; transition: opacity .2s; }
    .nav-cta-btn:hover { opacity: 0.85; text-decoration: none !important; }
    .nav-toggle { display: none; background: none; border: none; color: ${tpl.navColor}; font-size: 22px; cursor: pointer; padding: 4px; }

    /* ── Hero ── */
    .hero { min-height: 80vh; display: flex; align-items: center; color: white; padding: 120px 28px 80px; }
    .hero-inner { max-width: 760px; margin: 0 auto; text-align: center; }
    .hero h1 { font-size: clamp(36px, 6vw, 72px); margin: 0 0 16px; color: white; text-shadow: 0 2px 16px rgba(0,0,0,0.4); }
    .hero p { font-size: clamp(14px, 2vw, 18px); color: rgba(255,255,255,0.92); margin: 0 0 32px; text-shadow: 0 1px 6px rgba(0,0,0,0.5); }
    .hero-btns { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
    .hero a.cta { display: inline-block; background: var(--accent); color: #1a1a1a; padding: 14px 30px; border-radius: 8px; font-weight: 800; letter-spacing: 0.4px; font-size: 14px; transition: opacity .2s; }
    .hero a.cta:hover { opacity: 0.85; text-decoration: none; }
    .hero a.cta-ghost { display: inline-block; background: transparent; color: white; border: 2px solid rgba(255,255,255,0.7); padding: 12px 28px; border-radius: 8px; font-weight: 700; font-size: 14px; transition: background .2s; }
    .hero a.cta-ghost:hover { background: rgba(255,255,255,0.15); text-decoration: none; }

    /* ── Page hero (inner pages) ── */
    .page-hero { padding: 140px 28px 60px; text-align: center; background: ${tpl.altBg}; }
    .page-hero h1 { font-size: clamp(32px, 5vw, 56px); color: var(--primary); margin: 0; }
    .page-hero p { color: #666; margin: 12px auto 0; max-width: 560px; font-size: 16px; }

    /* ── Sections ── */
    .section { padding: 80px 0; }
    .section-alt { background: ${tpl.altBg}; }
    .section-dark { background: var(--primary); color: white; }
    .section-dark h2 { color: white; }
    .section-dark h2::after { background: var(--accent); }
    .section h2 { font-size: clamp(28px, 4vw, 42px); color: var(--primary); margin-bottom: 10px; text-align: center; }
    .section h2::after { content: ''; display: block; width: 52px; height: 3px; background: var(--accent); margin: 14px auto 32px; }

    /* ── Stats bar ── */
    .stats-bar { background: var(--primary); padding: 48px 0; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; text-align: center; }
    .stat-item { padding: 16px 8px; border-right: 1px solid rgba(255,255,255,0.12); }
    .stat-item:last-child { border-right: none; }
    .stat-value { font-family: ${tpl.headFont}; font-size: clamp(36px, 5vw, 56px); font-weight: 400; color: var(--accent); line-height: 1; display: block; }
    .stat-label { font-size: 11px; letter-spacing: 3px; text-transform: uppercase; color: rgba(255,255,255,0.55); margin-top: 8px; display: block; }
    @media (max-width: 600px) { .stats-grid { grid-template-columns: 1fr 1fr; } .stat-item { border-right: none; border-bottom: 1px solid rgba(255,255,255,0.12); } }

    /* ── Philosophy ── */
    .philosophy-inner { max-width: 780px; margin: 0 auto; text-align: center; }
    .philosophy-text { font-size: 18px; line-height: 1.75; color: #333; margin-bottom: 28px; }
    .philosophy-quote { border-left: 4px solid var(--accent); padding: 16px 24px; text-align: left; font-style: italic; font-family: ${tpl.headFont}; font-size: clamp(18px, 2.5vw, 24px); color: var(--primary); margin: 32px auto; max-width: 680px; background: ${tpl.altBg}; border-radius: 0 8px 8px 0; }
    .philosophy-quote cite { display: block; font-style: normal; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: #888; margin-top: 10px; font-family: ${tpl.bodyFont}; }

    /* ── Three pillars ── */
    .pillars-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; }
    .pillar-card { background: white; border: 1px solid #eee; border-radius: 12px; padding: 36px 28px; box-shadow: 0 4px 20px rgba(0,0,0,0.04); }
    .pillar-num { font-family: ${tpl.headFont}; font-size: 44px; font-weight: 300; color: var(--accent); line-height: 1; margin-bottom: 14px; display: block; }
    .pillar-title { font-family: ${tpl.headFont}; font-size: 22px; font-weight: 600; color: var(--primary); margin-bottom: 10px; }
    .pillar-text { font-size: 15px; color: #555; line-height: 1.65; }

    /* ── About / Story ── */
    .about-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: center; }
    .about-text h2 { text-align: left; }
    .about-text h2::after { margin-left: 0; }
    .about-text p { font-size: 16px; margin: 0 0 16px; color: #333; }
    .about-photo { aspect-ratio: 4 / 3; background-size: cover; background-position: center; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.14); }
    @media (max-width: 768px) { .about-grid { grid-template-columns: 1fr; } .about-text h2 { text-align: center; } .about-text h2::after { margin: 14px auto 32px; } }

    /* ── The Method ── */
    .method-intro { max-width: 680px; margin: 0 auto 48px; text-align: center; font-size: 16px; color: #555; line-height: 1.7; }
    .method-steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0; }
    .method-step { padding: 36px 32px; border-right: 1px solid rgba(255,255,255,0.15); text-align: center; }
    .method-step:last-child { border-right: none; }
    .method-zone { font-size: 10px; letter-spacing: 4px; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 10px; display: block; }
    .method-step h3 { font-family: ${tpl.headFont}; font-size: 22px; font-weight: 500; color: white; margin-bottom: 10px; }
    .method-step p { font-size: 14px; color: rgba(255,255,255,0.7); line-height: 1.65; margin: 0; }
    @media (max-width: 700px) { .method-steps { grid-template-columns: 1fr; } .method-step { border-right: none; border-bottom: 1px solid rgba(255,255,255,0.12); } }

    /* ── Featured dishes ── */
    .menu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 24px; }
    .menu-card { background: white; border: 1px solid #eee; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.05); transition: transform .2s; }
    .menu-card:hover { transform: translateY(-3px); }
    .menu-photo { aspect-ratio: 4 / 3; background-size: cover; background-position: center; background-color: #f5f5f5; }
    .menu-photo-empty { background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%); opacity: 0.15; }
    .menu-body { padding: 18px 20px; }
    .menu-tag { display: inline-block; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 8px; }
    .menu-name-row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .menu-name { font-family: ${tpl.headFont}; font-weight: 600; font-size: 18px; color: #1a1a1a; }
    .menu-price { font-weight: 800; color: var(--primary); white-space: nowrap; }
    .menu-desc { font-size: 13px; color: #666; margin-top: 8px; line-height: 1.5; }

    /* ── Gallery ── */
    .gallery-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .gallery-tile { aspect-ratio: 1 / 1; background-size: cover; background-position: center; border-radius: 10px; transition: transform .25s; }
    .gallery-tile:hover { transform: scale(1.02); }
    @media (max-width: 768px) { .gallery-grid { grid-template-columns: 1fr 1fr; } }

    /* ── Team ── */
    .team-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 28px; }
    .team-card { text-align: center; }
    .team-photo { width: 140px; height: 140px; margin: 0 auto 16px; border-radius: 50%; background-size: cover; background-position: center; box-shadow: 0 6px 20px rgba(0,0,0,0.12); }
    .team-photo-empty { background: var(--primary); opacity: 0.15; }
    .team-name { font-family: ${tpl.headFont}; font-weight: 700; font-size: 18px; color: #1a1a1a; }
    .team-role { font-size: 11px; color: var(--primary); text-transform: uppercase; letter-spacing: 1.5px; font-weight: 700; margin-top: 4px; }
    .team-bio { font-size: 13px; color: #555; margin-top: 10px; line-height: 1.6; }

    /* ── Press ── */
    .press-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 22px; }
    .press-card { background: white; border: 1px solid #eee; border-radius: 12px; padding: 24px; box-shadow: 0 4px 16px rgba(0,0,0,0.04); }
    .press-source { font-weight: 700; color: var(--primary); font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
    .press-quote { font-family: ${tpl.headFont}; font-style: italic; font-size: 17px; color: #333; margin: 0 0 12px; line-height: 1.55; border-left: 3px solid var(--accent); padding-left: 14px; }

    /* ── Booking CTA strip ── */
    .booking-strip { text-align: center; padding: 80px 28px; }
    .booking-strip h2 { color: var(--primary); }
    .booking-strip h2::after { margin-bottom: 24px; }
    .booking-strip p { color: #555; font-size: 16px; margin-bottom: 28px; }
    .booking-strip .phone { font-size: 16px; color: #666; margin-top: 16px; }
    .booking-strip .phone a { color: var(--primary); font-weight: 700; }

    /* ── Hours ── */
    .hours-card { max-width: 480px; margin: 0 auto; background: white; border: 1px solid #eee; border-radius: 12px; padding: 28px 36px; box-shadow: 0 4px 20px rgba(0,0,0,0.04); font-size: 16px; line-height: 2; text-align: center; }

    /* ── Visit / Contact ── */
    .visit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: start; }
    .visit-card { background: white; border: 1px solid #eee; border-radius: 12px; padding: 30px 34px; box-shadow: 0 4px 20px rgba(0,0,0,0.04); }
    .visit-row { display: flex; padding: 12px 0; border-bottom: 1px solid #f4f4f4; font-size: 15px; gap: 16px; }
    .visit-row:last-child { border-bottom: none; }
    .visit-label { font-weight: 700; color: var(--primary); min-width: 90px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; padding-top: 3px; }
    @media (max-width: 768px) { .visit-grid { grid-template-columns: 1fr; } }

    /* ── Catering ── */
    .cta-inline { display: inline-block; margin-top: 8px; background: var(--accent); color: #1a1a1a; padding: 11px 24px; border-radius: 8px; font-weight: 800; letter-spacing: 0.4px; font-size: 13px; transition: opacity .2s; }
    .cta-inline:hover { text-decoration: none; opacity: 0.85; }

    /* ── Full menu page ── */
    .menu-category { margin-bottom: 56px; }
    .menu-category-title { font-family: ${tpl.headFont}; font-size: 28px; color: var(--primary); border-bottom: 2px solid var(--accent); padding-bottom: 10px; margin-bottom: 24px; }
    .menu-list-item { display: flex; justify-content: space-between; align-items: baseline; padding: 14px 0; border-bottom: 1px solid #f0f0f0; gap: 16px; }
    .menu-list-name { font-family: ${tpl.headFont}; font-size: 17px; font-weight: 600; color: #1a1a1a; }
    .menu-list-desc { font-size: 13px; color: #777; margin-top: 3px; }
    .menu-list-price { font-weight: 800; color: var(--primary); white-space: nowrap; flex-shrink: 0; }

    /* ── Footer ── */
    footer { background: ${tpl.footerBg}; color: ${tpl.footerColor}; padding: 48px 28px 32px; }
    .footer-inner { max-width: 1140px; margin: 0 auto; text-align: center; }
    .footer-brand { font-family: ${tpl.headFont}; font-size: 22px; font-weight: 600; color: var(--accent); margin-bottom: 10px; }
    .footer-address { font-size: 14px; margin-bottom: 6px; opacity: 0.75; }
    .footer-contact { font-size: 14px; margin-bottom: 10px; }
    .footer-contact a { color: ${tpl.footerColor}; }
    .footer-social { font-size: 13px; margin-bottom: 16px; }
    .footer-social a { color: var(--accent); margin: 0 6px; }
    .footer-copy { font-size: 12px; opacity: 0.5; }
    .footer-copy a { color: var(--accent); }

    /* ── Mobile nav ── */
    @media (max-width: 680px) {
      .nav-toggle { display: block; }
      .nav-links { display: none; position: absolute; top: 100%; left: 0; right: 0; background: rgba(20,20,20,0.97); flex-direction: column; padding: 16px 0; }
      .nav-links.open { display: flex; }
      .nav-links a { padding: 12px 24px; color: #fff !important; width: 100%; }
      .nav-cta-btn { margin: 8px 24px 4px !important; text-align: center; }
    }

    /* ── Template overrides ── */
    ${tpl.extraCss || ''}
  `;
}

function makeHead(cfg, tpl, pageTitle, pageDesc) {
  const seoTitle  = escapeHtml(pageTitle  || cfg.restaurant_name || 'Restaurant');
  const seoDesc   = escapeHtml(pageDesc   || cfg.tagline         || '');
  const ogImage   = (cfg.sections || {}).seo_og_image || cfg.photo_hero || '';
  const s = cfg.sections || {};
  const ga = !s.ga_id ? '' : `
  <script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(s.ga_id)}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${escapeHtml(s.ga_id)}');</script>`;
  const fb = !s.fb_pixel_id ? '' : `
  <script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${escapeHtml(s.fb_pixel_id)}');fbq('track','PageView');</script>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${seoTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${seoDesc}" />
  <meta property="og:title" content="${seoTitle}" />
  <meta property="og:description" content="${seoDesc}" />
  ${ogImage ? `<meta property="og:image" content="${ogImage}" />` : ''}
  <meta property="og:type" content="restaurant.restaurant" />
  ${tpl.googleFonts ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${tpl.googleFonts}" rel="stylesheet">` : ''}
  ${ga}${fb}
  <style>${makeSharedCss(cfg, tpl)}</style>
</head>
<body>`;
}

// ── Section builders ──────────────────────────────────────────────────────────

function buildStats(cfg) {
  const s = cfg.sections || {};
  if (!s.stats_enabled) return '';
  const stats = s.stats || [];
  if (!stats.length) return '';
  const items = stats.map(st => `
    <div class="stat-item">
      <span class="stat-value">${escapeHtml(st.value)}</span>
      <span class="stat-label">${escapeHtml(st.label)}</span>
    </div>`).join('');
  return `<section class="stats-bar"><div class="container"><div class="stats-grid">${items}</div></div></section>`;
}

function buildPhilosophy(cfg, tpl) {
  const s = cfg.sections || {};
  if (!s.philosophy_enabled) return '';
  const eyebrow = s.philosophy_eyebrow || 'The Philosophy';
  const title   = s.philosophy_title   || '';
  const text    = s.philosophy_text    || '';
  const quote   = s.philosophy_quote   || '';
  const author  = s.philosophy_quote_author || '';
  if (!title && !text) return '';
  return `
  <section class="section">
    <div class="container">
      <div class="philosophy-inner">
        <span class="eyebrow">${escapeHtml(eyebrow)}</span>
        ${title ? `<h2>${escapeHtml(title)}</h2>` : ''}
        ${text  ? `<p class="philosophy-text">${escapeHtml(text).replace(/\n+/g,'</p><p class="philosophy-text">')}</p>` : ''}
        ${quote ? `<blockquote class="philosophy-quote">${escapeHtml(quote)}${author ? `<cite>— ${escapeHtml(author)}</cite>` : ''}</blockquote>` : ''}
      </div>
    </div>
  </section>`;
}

function buildPillars(cfg, tpl) {
  const s = cfg.sections || {};
  if (!s.pillars_enabled) return '';
  const pillars = s.pillars || [];
  if (!pillars.some(p => p.title || p.text)) return '';
  const eyebrow = s.pillars_eyebrow || 'What Sets Us Apart';
  const cards = pillars.map((p, i) => `
    <div class="pillar-card">
      <span class="pillar-num">0${i + 1}</span>
      <div class="pillar-title">${escapeHtml(p.title || '')}</div>
      <div class="pillar-text">${escapeHtml(p.text || '').replace(/\n+/g, '<br>')}</div>
    </div>`).join('');
  return `
  <section class="section section-alt">
    <div class="container">
      <span class="eyebrow">${escapeHtml(eyebrow)}</span>
      <div class="pillars-grid">${cards}</div>
    </div>
  </section>`;
}

function buildMethod(cfg, tpl) {
  const s = cfg.sections || {};
  if (!s.method_enabled) return '';
  const steps = s.method_steps || [];
  if (!steps.some(st => st.title || st.text)) return '';
  const title = s.method_title || 'How It Works';
  const intro = s.method_intro || '';
  const stepHtml = steps.map(st => `
    <div class="method-step">
      <span class="method-zone">${escapeHtml(st.zone || '')}</span>
      <h3>${escapeHtml(st.title || '')}</h3>
      <p>${escapeHtml(st.text || '')}</p>
    </div>`).join('');
  return `
  <section class="section section-dark">
    <div class="container">
      <h2 style="color:white;text-align:center;">${escapeHtml(title)}</h2>
      <div style="width:52px;height:3px;background:var(--accent);margin:14px auto 32px;"></div>
      ${intro ? `<p class="method-intro" style="color:rgba(255,255,255,0.75);">${escapeHtml(intro)}</p>` : ''}
      <div class="method-steps">${stepHtml}</div>
    </div>
  </section>`;
}

function buildFeaturedDishes(cfg, tpl) {
  const s = cfg.sections || {};
  if (!s.menu_enabled) return '';
  const items = s.menu_items || [];
  if (!items.length) return '';
  const cards = items.map(m => `
    <div class="menu-card">
      ${m.photo ? `<div class="menu-photo" style="background-image:url('${m.photo}')"></div>` : '<div class="menu-photo menu-photo-empty"></div>'}
      <div class="menu-body">
        ${m.category ? `<span class="menu-tag">${escapeHtml(m.category)}</span>` : ''}
        <div class="menu-name-row">
          <span class="menu-name">${escapeHtml(m.name)}</span>
          <span class="menu-price">£${Number(m.price || 0).toFixed(2)}</span>
        </div>
        ${m.description ? `<div class="menu-desc">${escapeHtml(m.description)}</div>` : ''}
      </div>
    </div>`).join('');
  return `
  <section class="section">
    <div class="container">
      <span class="eyebrow">From the Kitchen</span>
      <h2>Selected dishes</h2>
      <div class="menu-grid">${cards}</div>
      <div style="text-align:center;margin-top:32px;">
        <a href="menu.html" style="font-weight:700;color:var(--primary);font-size:15px;">View full menu →</a>
      </div>
    </div>
  </section>`;
}

function buildGallery(cfg) {
  const s = cfg.sections || {};
  if (s.gallery_enabled === false) return '';
  const photos = [
    cfg.photo_gallery_1, cfg.photo_gallery_2, cfg.photo_gallery_3,
    cfg.photo_gallery_4, cfg.photo_gallery_5, cfg.photo_gallery_6,
  ].filter(Boolean);
  if (!photos.length) return '';
  return `
  <section class="section section-alt">
    <div class="container">
      <span class="eyebrow">Gallery</span>
      <h2>Our Space</h2>
      <div class="gallery-grid">
        ${photos.map(src => `<div class="gallery-tile" style="background-image:url('${src}')"></div>`).join('')}
      </div>
    </div>
  </section>`;
}

function buildBookingStrip(cfg) {
  const s = cfg.sections || {};
  const showBooking = s.booking_widget_enabled && s.widget_base_url;
  const showOrder   = s.takeaway_widget_enabled && s.widget_base_url;
  if (!showBooking && !showOrder) return '';
  const phone = escapeHtml(cfg.phone || '');
  return `
  <section class="section-alt booking-strip">
    <div class="container">
      ${showBooking ? `
        <span class="eyebrow">Reservations</span>
        <h2>Reserve your table</h2>
        <p>Book directly with us. Zero commission. Instant confirmation.</p>
        <div id="siamepos-booking-widget"></div>
        <script src="${escapeHtml(s.widget_base_url)}/widget.js" defer></script>
        ${phone ? `<p class="phone">Or call us: <a href="tel:${phone}">${phone}</a></p>` : ''}
      ` : ''}
      ${showOrder ? `
        <span class="eyebrow" style="margin-top:40px;display:block;">Online Order</span>
        <h2>Order online</h2>
        <div id="siamepos-takeaway-widget"></div>
        <script src="${escapeHtml(s.widget_base_url)}/takeaway-widget.js" defer></script>
      ` : ''}
    </div>
  </section>`;
}

function buildHours(cfg) {
  const s = cfg.sections || {};
  if (!s.hours_enabled || !(s.hours_text || '').trim()) return '';
  return `
  <section class="section">
    <div class="container">
      <span class="eyebrow">Opening Hours</span>
      <h2>When to visit</h2>
      <div class="hours-card">${escapeHtml(s.hours_text).replace(/\n/g, '<br>')}</div>
    </div>
  </section>`;
}

function buildVisit(cfg) {
  const address = escapeHtml(cfg.address || '');
  const phone   = escapeHtml(cfg.phone   || '');
  const email   = escapeHtml(cfg.email   || '');
  if (!address && !phone && !email) return '';
  return `
  <section class="section section-alt">
    <div class="container">
      <span class="eyebrow">Find Us</span>
      <h2>Visit us</h2>
      <div class="visit-card" style="max-width:540px;margin:0 auto;">
        ${address ? `<div class="visit-row"><span class="visit-label">Address</span><span>${address.replace(/\n/g,'<br>')}</span></div>` : ''}
        ${phone   ? `<div class="visit-row"><span class="visit-label">Phone</span><span><a href="tel:${phone}">${phone}</a></span></div>` : ''}
        ${email   ? `<div class="visit-row"><span class="visit-label">Email</span><span><a href="mailto:${email}">${email}</a></span></div>` : ''}
      </div>
    </div>
  </section>`;
}

function buildStory(cfg, tpl) {
  const s = cfg.sections || {};
  if (s.story_enabled === false) return '';
  const about = escapeHtml(cfg.about_text || '');
  const photo = cfg.photo_story || '';
  if (!about && !photo) return '';
  return `
  <section class="section ${photo ? '' : 'section-alt'}">
    <div class="container">
      <div class="about-grid">
        <div class="about-text">
          <span class="eyebrow">Our Story</span>
          <h2>A house built on memory</h2>
          ${about ? `<p>${about.replace(/\n+/g,'</p><p>')}</p>` : ''}
        </div>
        ${photo ? `<div class="about-photo" style="background-image:url('${photo}')"></div>` : ''}
      </div>
    </div>
  </section>`;
}

function buildCatering(cfg) {
  const s = cfg.sections || {};
  if (!s.catering_enabled || !(s.catering_text || '').trim()) return '';
  const phone = escapeHtml(cfg.phone || '');
  const email = escapeHtml(cfg.email || '');
  return `
  <section class="section section-alt">
    <div class="container">
      <div class="about-grid">
        <div class="about-text">
          <span class="eyebrow">Catering &amp; Events</span>
          <h2>Private dining</h2>
          <p>${escapeHtml(s.catering_text).replace(/\n+/g,'</p><p>')}</p>
          ${phone || email ? `<a class="cta-inline" href="${email ? `mailto:${email}` : `tel:${phone}`}">Enquire now</a>` : ''}
        </div>
        ${s.catering_photo ? `<div class="about-photo" style="background-image:url('${s.catering_photo}')"></div>` : ''}
      </div>
    </div>
  </section>`;
}

function buildPress(cfg, tpl) {
  const s = cfg.sections || {};
  if (!s.press_enabled || !Array.isArray(s.press_items) || !s.press_items.length) return '';
  const cards = s.press_items.map(p => `
    <div class="press-card">
      ${p.source ? `<div class="press-source">${escapeHtml(p.source)}</div>` : ''}
      ${p.quote  ? `<blockquote class="press-quote">${escapeHtml(p.quote)}</blockquote>` : ''}
      ${p.link   ? `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener" style="font-size:13px;font-weight:700;">Read more →</a>` : ''}
    </div>`).join('');
  return `
  <section class="section">
    <div class="container">
      <span class="eyebrow">In the Press</span>
      <h2>What they say</h2>
      <div class="press-grid">${cards}</div>
    </div>
  </section>`;
}

function buildTeam(cfg) {
  const s = cfg.sections || {};
  if (!s.team_enabled || !Array.isArray(s.team_members) || !s.team_members.length) return '';
  const cards = s.team_members.map(t => `
    <div class="team-card">
      ${t.photo ? `<div class="team-photo" style="background-image:url('${t.photo}')"></div>` : '<div class="team-photo team-photo-empty"></div>'}
      <div class="team-name">${escapeHtml(t.name || '')}</div>
      ${t.role ? `<div class="team-role">${escapeHtml(t.role)}</div>` : ''}
      ${t.bio  ? `<div class="team-bio">${escapeHtml(t.bio)}</div>`  : ''}
    </div>`).join('');
  return `
  <section class="section section-alt">
    <div class="container">
      <span class="eyebrow">Meet the Team</span>
      <h2>The people behind the food</h2>
      <div class="team-grid">${cards}</div>
    </div>
  </section>`;
}

// ── Page generators ───────────────────────────────────────────────────────────

function generateIndex(cfg, tpl) {
  const name    = escapeHtml(cfg.restaurant_name || 'Your Restaurant');
  const tagline = escapeHtml(cfg.tagline || '');
  const s       = cfg.sections || {};

  const heroBg = cfg.photo_hero
    ? `background-image: linear-gradient(rgba(0,0,0,0.50), rgba(0,0,0,0.50)), url('${cfg.photo_hero}'); background-size:cover; background-position:center;`
    : `background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);`;

  const hasBook  = s.booking_widget_enabled && s.widget_base_url;
  const hasOrder = s.takeaway_widget_enabled && s.widget_base_url;

  return makeHead(cfg, tpl, name, tagline) + `
${makeNav(cfg, tpl, 'index')}

<header class="hero" style="${heroBg}">
  <div class="hero-inner">
    <p style="font-size:12px;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.7);margin-bottom:12px;">${escapeHtml(cfg.address ? cfg.address.split('\n').pop() : '')}</p>
    <h1>${name}</h1>
    ${tagline ? `<p>${tagline}</p>` : ''}
    <div class="hero-btns">
      ${hasBook  ? `<a class="cta" href="#book">Book a Table</a>` : `<a class="cta" href="contact.html">Visit Us</a>`}
      ${hasOrder ? `<a class="cta-ghost" href="#order">Order Online</a>` : `<a class="cta-ghost" href="menu.html">View Menu</a>`}
    </div>
  </div>
</header>

${buildStats(cfg)}
${buildPhilosophy(cfg, tpl)}
${buildPillars(cfg, tpl)}
${buildFeaturedDishes(cfg, tpl)}
${buildGallery(cfg)}
${buildMethod(cfg, tpl)}
${buildStory(cfg, tpl)}
${buildCatering(cfg)}
${buildBookingStrip(cfg)}
${buildHours(cfg)}
${buildVisit(cfg)}

${makeFooter(cfg, tpl)}
</body></html>`;
}

function generateAbout(cfg, tpl) {
  const name    = escapeHtml(cfg.restaurant_name || 'Restaurant');
  const tagline = escapeHtml(cfg.tagline || '');
  const about   = escapeHtml(cfg.about_text || '');
  const photo   = cfg.photo_story || '';

  return makeHead(cfg, tpl, `About — ${name}`, tagline) + `
${makeNav(cfg, tpl, 'about')}

<div class="page-hero">
  <span class="eyebrow">Our Story</span>
  <h1>About ${name}</h1>
  ${tagline ? `<p>${tagline}</p>` : ''}
</div>

${about || photo ? `
<section class="section">
  <div class="container">
    <div class="about-grid">
      <div class="about-text">
        ${about ? `<p>${about.replace(/\n+/g,'</p><p>')}</p>` : ''}
      </div>
      ${photo ? `<div class="about-photo" style="background-image:url('${photo}')"></div>` : ''}
    </div>
  </div>
</section>` : ''}

${buildTeam(cfg)}
${buildPress(cfg, tpl)}
${buildCatering(cfg)}

${makeFooter(cfg, tpl)}
</body></html>`;
}

function generateMenu(cfg, tpl) {
  const name = escapeHtml(cfg.restaurant_name || 'Restaurant');
  const s    = cfg.sections || {};
  const items = s.menu_items || [];

  // Group by category
  const byCategory = {};
  items.forEach(it => {
    const cat = it.category || 'Dishes';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(it);
  });

  const menuHtml = Object.entries(byCategory).map(([cat, dishes]) => `
    <div class="menu-category">
      <div class="menu-category-title">${escapeHtml(cat)}</div>
      ${dishes.map(m => `
        <div class="menu-list-item">
          <div>
            <div class="menu-list-name">${escapeHtml(m.name)}</div>
            ${m.description ? `<div class="menu-list-desc">${escapeHtml(m.description)}</div>` : ''}
          </div>
          <div class="menu-list-price">£${Number(m.price || 0).toFixed(2)}</div>
        </div>`).join('')}
    </div>`).join('');

  const noMenu = `<p style="color:#888;text-align:center;padding:40px 0;">Menu coming soon. Please call us or visit for today's specials.</p>`;

  return makeHead(cfg, tpl, `Menu — ${name}`, 'Our menu') + `
${makeNav(cfg, tpl, 'menu')}

<div class="page-hero">
  <span class="eyebrow">From the Kitchen</span>
  <h1>Our Menu</h1>
</div>

<section class="section">
  <div class="container" style="max-width:800px;">
    ${menuHtml || noMenu}
  </div>
</section>

${makeFooter(cfg, tpl)}
</body></html>`;
}

function generateContact(cfg, tpl) {
  const name    = escapeHtml(cfg.restaurant_name || 'Restaurant');
  const address = escapeHtml(cfg.address || '');
  const phone   = escapeHtml(cfg.phone   || '');
  const email   = escapeHtml(cfg.email   || '');
  const s       = cfg.sections || {};

  return makeHead(cfg, tpl, `Contact — ${name}`, 'Find us and get in touch') + `
${makeNav(cfg, tpl, 'contact')}

<div class="page-hero">
  <span class="eyebrow">Get in Touch</span>
  <h1>Visit Us</h1>
</div>

<section class="section">
  <div class="container">
    <div class="visit-grid">
      <div>
        <span class="eyebrow">The Address</span>
        <div class="visit-card" style="margin-top:16px;">
          ${address ? `<div class="visit-row"><span class="visit-label">Address</span><span>${address.replace(/\n/g,'<br>')}</span></div>` : ''}
          ${phone   ? `<div class="visit-row"><span class="visit-label">Phone</span><span><a href="tel:${phone}">${phone}</a></span></div>` : ''}
          ${email   ? `<div class="visit-row"><span class="visit-label">Email</span><span><a href="mailto:${email}">${email}</a></span></div>` : ''}
        </div>
      </div>
      ${s.hours_enabled && (s.hours_text || '').trim() ? `
      <div>
        <span class="eyebrow">Opening Hours</span>
        <div class="hours-card" style="margin-top:16px;text-align:left;">${escapeHtml(s.hours_text).replace(/\n/g,'<br>')}</div>
      </div>` : ''}
    </div>
  </div>
</section>

${makeFooter(cfg, tpl)}
</body></html>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function generateMultiPageWebsite(cfg) {
  const tpl = TEMPLATES[cfg.template] || TEMPLATES.classic;
  return {
    'index.html':   generateIndex(cfg, tpl),
    'about.html':   generateAbout(cfg, tpl),
    'menu.html':    generateMenu(cfg, tpl),
    'contact.html': generateContact(cfg, tpl),
  };
}

// Legacy single-page — kept for live preview only (uses index.html output)
export function generateWebsiteHtml(cfg) {
  const pages = generateMultiPageWebsite(cfg);
  return pages['index.html'];
}

// Compress an image File to a base64 JPEG, max 1600px wide.
export function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = e => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const maxW = 1600;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
