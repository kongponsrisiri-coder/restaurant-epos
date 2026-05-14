// SEPOS-WEB-001 — self-contained restaurant website generator.
// Returns a single HTML string with inline CSS and base64-embedded
// photos, so the generated file can be opened anywhere (or uploaded
// as-is to Netlify / their preferred host).

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// SEPOS-WEB-003 — four built-in design templates. Each tweaks
// typography + a small amount of CSS; layout and section behaviour
// are shared so they remain familiar. Google Fonts are loaded via
// <link> in <head>, with system fallbacks so the file still works
// offline (just degrades to native serif/sans).
export const TEMPLATES = {
  classic: {
    label: 'Classic Thai',
    description: 'Warm Georgia serif, image-led — the original look.',
    headFont:  `Georgia, 'Times New Roman', serif`,
    bodyFont:  `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`,
    googleFonts: '',
    altBg:     '#faf7f2',
    extraCss:  '',
  },
  modern: {
    label: 'Modern Minimal',
    description: 'Inter sans throughout, lots of whitespace, no fuss.',
    headFont:  `Inter, -apple-system, BlinkMacSystemFont, sans-serif`,
    bodyFont:  `Inter, -apple-system, BlinkMacSystemFont, sans-serif`,
    googleFonts: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap',
    altBg:     '#ffffff',
    extraCss: `
      .section { padding: 100px 0; border-bottom: 1px solid #f0f0f0; }
      .section-alt { background: #ffffff; }
      .section h2 { text-align: left; font-weight: 800; letter-spacing: -0.5px; }
      .section h2::after { margin: 12px 0 0; width: 40px; }
      .nav { background: white; border-bottom: 1px solid #eee; }
      .hero h1 { font-weight: 800; letter-spacing: -1.5px; }
    `,
  },
  editorial: {
    label: 'Bold Editorial',
    description: 'Big Playfair Display headlines, magazine-style.',
    headFont:  `'Playfair Display', Georgia, serif`,
    bodyFont:  `'Source Sans 3', -apple-system, sans-serif`,
    googleFonts: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;800&family=Source+Sans+3:wght@400;600&display=swap',
    altBg:     '#f9f5ee',
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
    altBg:     '#f3ece1',
    extraCss: `
      .hero h1 { font-weight: 500; font-style: italic; }
      .section h2 { font-weight: 500; font-style: italic; }
      .nav-brand { font-style: italic; }
      .about-text p { font-size: 17px; }
    `,
  },
};

// Darken / lighten a hex colour. Keeps the template self-contained.
function shade(hex, pct) {
  const n = (parseInt((hex || '#000000').replace('#', ''), 16) || 0);
  let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const adj = c => Math.max(0, Math.min(255, Math.round(c + (pct < 0 ? c : (255 - c)) * pct)));
  r = adj(r); g = adj(g); b = adj(b);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

export function generateWebsiteHtml(cfg) {
  const c = cfg || {};
  const primary = c.primary_colour || '#7B1C2D';
  const accent  = c.accent_colour  || '#C49030';
  const primaryDark = shade(primary, -0.25);
  const name = escapeHtml(c.restaurant_name || 'Your Restaurant');
  const tagline = escapeHtml(c.tagline || '');
  const about = escapeHtml(c.about_text || '');
  const address = escapeHtml(c.address || '');
  const phone = escapeHtml(c.phone || '');
  const email = escapeHtml(c.email || '');
  const tpl = TEMPLATES[c.template] || TEMPLATES.classic;
  const logoUrl = c.logo_url || '';

  const heroBg = c.photo_hero
    ? `background-image: linear-gradient(rgba(0,0,0,0.45), rgba(0,0,0,0.45)), url('${c.photo_hero}');`
    : `background: linear-gradient(135deg, ${primary} 0%, ${primaryDark} 100%);`;

  // SEPOS-WEB-002 — section toggles + content live in cfg.sections.
  // Defaults preserve the previous one-pager behaviour: story + gallery
  // + visit always shown if their data is present; hours / press /
  // catering are opt-in.
  const s = c.sections || {};
  const showStory    = s.story_enabled !== false  && (about || c.photo_story);
  const showGallery  = s.gallery_enabled !== false && (c.photo_gallery_1 || c.photo_gallery_2 || c.photo_gallery_3);
  const showHours    = !!s.hours_enabled    && !!(s.hours_text || '').trim();
  const showPress    = !!s.press_enabled    && Array.isArray(s.press_items) && s.press_items.length > 0;
  const showCatering = !!s.catering_enabled && !!(s.catering_text || '').trim();
  const showVisit    = !!(address || phone || email);
  const showBooking  = !!s.booking_widget_enabled  && !!s.widget_base_url;
  const showOrder    = !!s.takeaway_widget_enabled && !!s.widget_base_url;
  const showMenu     = !!s.menu_enabled && Array.isArray(s.menu_items) && s.menu_items.length > 0;
  const showTeam     = !!s.team_enabled && Array.isArray(s.team_members) && s.team_members.length > 0;

  const galleryPhotos = [c.photo_gallery_1, c.photo_gallery_2, c.photo_gallery_3].filter(Boolean);
  const galleryHtml = !showGallery ? '' : `
    <section id="gallery" class="section">
      <div class="container">
        <h2>Gallery</h2>
        <div class="gallery-grid">
          ${galleryPhotos.map(src => `<div class="gallery-tile" style="background-image: url('${src}')"></div>`).join('')}
        </div>
      </div>
    </section>`;

  const storyHtml = !showStory ? '' : `
    <section id="about" class="section section-alt">
      <div class="container about-grid">
        <div class="about-text">
          <h2>Our story</h2>
          ${about ? `<p>${about.replace(/\n+/g, '</p><p>')}</p>` : ''}
        </div>
        ${c.photo_story ? `<div class="about-photo" style="background-image: url('${c.photo_story}')"></div>` : ''}
      </div>
    </section>`;

  const hoursHtml = !showHours ? '' : `
    <section id="hours" class="section section-alt">
      <div class="container">
        <h2>Hours</h2>
        <div class="hours-card">${escapeHtml(s.hours_text).replace(/\n/g, '<br>')}</div>
      </div>
    </section>`;

  const pressHtml = !showPress ? '' : `
    <section id="press" class="section">
      <div class="container">
        <h2>In the press</h2>
        <div class="press-grid">
          ${(s.press_items || []).map(p => `
            <div class="press-card">
              ${p.source ? `<div class="press-source">${escapeHtml(p.source)}</div>` : ''}
              ${p.quote  ? `<blockquote class="press-quote">${escapeHtml(p.quote)}</blockquote>` : ''}
              ${p.link   ? `<a href="${escapeHtml(p.link)}" target="_blank" rel="noopener">Read more →</a>` : ''}
            </div>`).join('')}
        </div>
      </div>
    </section>`;

  const cateringHtml = !showCatering ? '' : `
    <section id="catering" class="section section-alt">
      <div class="container about-grid">
        <div class="about-text">
          <h2>Catering &amp; events</h2>
          <p>${escapeHtml(s.catering_text).replace(/\n+/g, '</p><p>')}</p>
          ${phone || email
            ? `<p><a class="cta-inline" href="${email ? `mailto:${email}` : `tel:${phone}`}">Enquire now</a></p>`
            : ''}
        </div>
        ${s.catering_photo ? `<div class="about-photo" style="background-image: url('${s.catering_photo}')"></div>` : ''}
      </div>
    </section>`;

  const visitHtml = !showVisit ? '' : `
    <section id="visit" class="section">
      <div class="container">
        <h2>Visit us</h2>
        <div class="visit-card">
          ${address ? `<div class="visit-row"><span class="visit-label">Address</span><span>${address.replace(/\n/g, '<br>')}</span></div>` : ''}
          ${phone   ? `<div class="visit-row"><span class="visit-label">Phone</span><span><a href="tel:${phone}">${phone}</a></span></div>` : ''}
          ${email   ? `<div class="visit-row"><span class="visit-label">Email</span><span><a href="mailto:${email}">${email}</a></span></div>` : ''}
        </div>
      </div>
    </section>`;

  // SEPOS-WEB-004 — featured dishes pulled from the EPOS menu. Each
  // item is a snapshot { name, price, photo, description } so the
  // generated HTML stays self-contained. Operator re-pulls + re-saves
  // to refresh.
  const menuHtml = !showMenu ? '' : `
    <section id="menu" class="section">
      <div class="container">
        <h2>Featured dishes</h2>
        <div class="menu-grid">
          ${s.menu_items.map(m => `
            <div class="menu-card">
              ${m.photo ? `<div class="menu-photo" style="background-image: url('${m.photo}')"></div>` : '<div class="menu-photo menu-photo-empty"></div>'}
              <div class="menu-body">
                <div class="menu-name-row">
                  <span class="menu-name">${escapeHtml(m.name)}</span>
                  <span class="menu-price">£${Number(m.price || 0).toFixed(2)}</span>
                </div>
                ${m.description ? `<div class="menu-desc">${escapeHtml(m.description)}</div>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>
    </section>`;

  // SEPOS-WEB-004 — chef + team profiles.
  const teamHtml = !showTeam ? '' : `
    <section id="team" class="section section-alt">
      <div class="container">
        <h2>Meet the team</h2>
        <div class="team-grid">
          ${s.team_members.map(t => `
            <div class="team-card">
              ${t.photo ? `<div class="team-photo" style="background-image: url('${t.photo}')"></div>` : '<div class="team-photo team-photo-empty"></div>'}
              <div class="team-name">${escapeHtml(t.name || '')}</div>
              ${t.role ? `<div class="team-role">${escapeHtml(t.role)}</div>` : ''}
              ${t.bio  ? `<div class="team-bio">${escapeHtml(t.bio)}</div>` : ''}
            </div>`).join('')}
        </div>
      </div>
    </section>`;

  // SEPOS-WEB-003 — booking + takeaway widget embeds. The widgets are
  // hosted as standalone scripts on the restaurant's EPOS server; the
  // generator just needs the base URL (set in sections.widget_base_url —
  // typically the client's railway_url, or the SiamEPOS demo URL).
  const bookingHtml = !showBooking ? '' : `
    <section id="book" class="section">
      <div class="container">
        <h2>Book a table</h2>
        <div id="siamepos-booking-widget"></div>
        <script src="${escapeHtml(s.widget_base_url)}/widget.js" defer></script>
      </div>
    </section>`;
  const orderHtml = !showOrder ? '' : `
    <section id="order" class="section section-alt">
      <div class="container">
        <h2>Order online</h2>
        <div id="siamepos-takeaway-widget"></div>
        <script src="${escapeHtml(s.widget_base_url)}/takeaway-widget.js" defer></script>
      </div>
    </section>`;

  // SEPOS-WEB-004 — SEO + social overrides. Falls back to identity
  // fields so existing sites without explicit SEO still get sensible
  // defaults.
  const seoTitle       = escapeHtml(s.seo_title       || c.restaurant_name || 'Restaurant');
  const seoDescription = escapeHtml(s.seo_description || c.tagline         || '');
  const seoOgImage     = s.seo_og_image || c.photo_hero || '';

  // SEPOS-WEB-004 — analytics injection. GA4 measurement ID + Facebook
  // Pixel ID are pasted as-is into the snippet templates. Empty values
  // skip the script tag entirely.
  const gaSnippet = !s.ga_id ? '' : `
  <script async src="https://www.googletagmanager.com/gtag/js?id=${escapeHtml(s.ga_id)}"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${escapeHtml(s.ga_id)}');</script>`;
  const fbSnippet = !s.fb_pixel_id ? '' : `
  <script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${escapeHtml(s.fb_pixel_id)}');fbq('track','PageView');</script>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${seoTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${seoDescription}" />
  <meta property="og:title"       content="${seoTitle}" />
  <meta property="og:description" content="${seoDescription}" />
  ${seoOgImage ? `<meta property="og:image" content="${seoOgImage}" />` : ''}
  <meta property="og:type" content="restaurant.restaurant" />
  ${tpl.googleFonts ? `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${tpl.googleFonts}" rel="stylesheet">` : ''}
  ${gaSnippet}
  ${fbSnippet}
  <style>
    :root { --primary: ${primary}; --primary-dark: ${primaryDark}; --accent: ${accent}; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: ${tpl.bodyFont}; color: #1a1a1a; line-height: 1.6; }
    h1, h2, h3 { font-family: ${tpl.headFont}; line-height: 1.2; margin: 0 0 0.5em; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

    /* Top nav */
    .nav { position: sticky; top: 0; z-index: 50; background: rgba(255,255,255,0.97); border-bottom: 1px solid #eee; backdrop-filter: blur(8px); }
    .nav-inner { display: flex; align-items: center; padding: 14px 24px; max-width: 1100px; margin: 0 auto; }
    .nav-brand { font-family: ${tpl.headFont}; font-weight: 700; font-size: 20px; color: var(--primary); letter-spacing: 0.5px; display: inline-flex; align-items: center; gap: 10px; }
    .nav-logo { height: 32px; width: auto; }
    .nav-links { margin-left: auto; display: flex; gap: 22px; }
    .nav-links a { color: #444; font-size: 14px; font-weight: 600; }
    .nav-links a:hover { color: var(--primary); text-decoration: none; }

    /* Hero */
    .hero { ${heroBg} background-size: cover; background-position: center; min-height: 70vh; display: flex; align-items: center; color: white; padding: 80px 24px; }
    .hero-inner { max-width: 720px; margin: 0 auto; text-align: center; }
    .hero h1 { font-size: clamp(36px, 6vw, 64px); margin: 0 0 14px; color: white; text-shadow: 0 2px 12px rgba(0,0,0,0.4); }
    .hero p { font-size: clamp(15px, 2vw, 19px); color: rgba(255,255,255,0.95); margin: 0 0 28px; text-shadow: 0 1px 6px rgba(0,0,0,0.5); }
    .hero a.cta { display: inline-block; background: var(--accent); color: #1a1a1a; padding: 13px 28px; border-radius: 999px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; font-size: 13px; }
    .hero a.cta:hover { background: white; text-decoration: none; }

    /* Sections */
    .section { padding: 70px 0; }
    .section-alt { background: ${tpl.altBg}; }
    .section h2 { font-size: 32px; color: var(--primary); margin-bottom: 22px; text-align: center; }
    .section h2::after { content: ''; display: block; width: 56px; height: 3px; background: var(--accent); margin: 12px auto 0; }

    /* About */
    .about-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 50px; align-items: center; }
    .about-text p { font-size: 16px; margin: 0 0 14px; color: #333; }
    .about-photo { aspect-ratio: 4 / 3; background-size: cover; background-position: center; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.15); }
    @media (max-width: 768px) {
      .about-grid { grid-template-columns: 1fr; }
      .about-text h2 { text-align: center; }
    }

    /* Gallery */
    .gallery-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
    .gallery-tile { aspect-ratio: 1 / 1; background-size: cover; background-position: center; border-radius: 10px; transition: transform 0.25s; }
    .gallery-tile:hover { transform: scale(1.02); }
    @media (max-width: 768px) { .gallery-grid { grid-template-columns: 1fr 1fr; } }

    /* Visit */
    .visit-card { max-width: 560px; margin: 0 auto; background: white; border: 1px solid #eee; border-radius: 12px; padding: 28px 32px; box-shadow: 0 4px 20px rgba(0,0,0,0.04); }
    .visit-row { display: flex; padding: 12px 0; border-bottom: 1px solid #f4f4f4; font-size: 15px; }
    .visit-row:last-child { border-bottom: none; }
    .visit-label { font-weight: 700; color: var(--primary); min-width: 100px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px; padding-top: 2px; }

    /* Hours */
    .hours-card { max-width: 480px; margin: 0 auto; background: white; border: 1px solid #eee; border-radius: 12px; padding: 24px 32px; box-shadow: 0 4px 20px rgba(0,0,0,0.04); font-size: 16px; line-height: 2; text-align: center; }

    /* Press */
    .press-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 22px; }
    .press-card { background: white; border: 1px solid #eee; border-radius: 12px; padding: 22px 24px; box-shadow: 0 4px 16px rgba(0,0,0,0.04); }
    .press-source { font-weight: 700; color: var(--primary); font-size: 13px; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; }
    .press-quote { font-family: Georgia, serif; font-style: italic; font-size: 17px; color: #333; margin: 0 0 12px; line-height: 1.55; border-left: 3px solid var(--accent); padding-left: 14px; }

    /* Catering CTA */
    .cta-inline { display: inline-block; margin-top: 8px; background: var(--accent); color: #1a1a1a; padding: 10px 22px; border-radius: 999px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; font-size: 12px; }
    .cta-inline:hover { text-decoration: none; opacity: 0.9; }

    /* Featured menu */
    .menu-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 22px; }
    .menu-card { background: white; border: 1px solid #eee; border-radius: 14px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.05); transition: transform 0.2s; }
    .menu-card:hover { transform: translateY(-3px); }
    .menu-photo { aspect-ratio: 4 / 3; background-size: cover; background-position: center; background-color: #f5f5f5; }
    .menu-photo-empty { background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%); opacity: 0.15; }
    .menu-body { padding: 16px 18px; }
    .menu-name-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .menu-name { font-family: Georgia, serif; font-weight: 700; font-size: 17px; color: #1a1a1a; }
    .menu-price { font-weight: 800; color: var(--primary); white-space: nowrap; }
    .menu-desc { font-size: 13px; color: #666; margin-top: 6px; line-height: 1.4; }

    /* Team / chef profiles */
    .team-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 26px; }
    .team-card { text-align: center; }
    .team-photo { width: 140px; height: 140px; margin: 0 auto 14px; border-radius: 50%; background-size: cover; background-position: center; box-shadow: 0 6px 20px rgba(0,0,0,0.12); }
    .team-photo-empty { background: var(--primary); opacity: 0.15; }
    .team-name { font-family: Georgia, serif; font-weight: 700; font-size: 17px; color: #1a1a1a; }
    .team-role { font-size: 12px; color: var(--primary); text-transform: uppercase; letter-spacing: 1px; font-weight: 700; margin-top: 4px; }
    .team-bio { font-size: 13px; color: #555; margin-top: 10px; line-height: 1.55; }

    /* Footer */
    footer { background: var(--primary-dark); color: rgba(255,255,255,0.78); text-align: center; padding: 28px 24px; font-size: 13px; }
    footer a { color: var(--accent); }

    /* Nav hide on small */
    @media (max-width: 600px) { .nav-links a:not(:last-child) { display: none; } }

    /* Template-specific overrides */
    ${tpl.extraCss || ''}
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <div class="nav-brand">
        ${logoUrl ? `<img class="nav-logo" src="${logoUrl}" alt="${name}" />` : ''}
        <span>${name}</span>
      </div>
      <div class="nav-links">
        ${storyHtml    ? '<a href="#about">About</a>'        : ''}
        ${menuHtml     ? '<a href="#menu">Menu</a>'          : ''}
        ${galleryHtml  ? '<a href="#gallery">Gallery</a>'    : ''}
        ${teamHtml     ? '<a href="#team">Team</a>'          : ''}
        ${hoursHtml    ? '<a href="#hours">Hours</a>'        : ''}
        ${pressHtml    ? '<a href="#press">Press</a>'        : ''}
        ${cateringHtml ? '<a href="#catering">Catering</a>'  : ''}
        ${orderHtml    ? '<a href="#order">Order online</a>' : ''}
        ${bookingHtml  ? '<a href="#book">Book</a>'          : ''}
        ${visitHtml    ? '<a href="#visit">Visit</a>'        : ''}
      </div>
    </div>
  </nav>

  <header class="hero">
    <div class="hero-inner">
      <h1>${name}</h1>
      ${tagline ? `<p>${tagline}</p>` : ''}
      ${visitHtml ? '<a href="#visit" class="cta">Visit us</a>' : ''}
    </div>
  </header>

  ${storyHtml}
  ${menuHtml}
  ${galleryHtml}
  ${teamHtml}
  ${hoursHtml}
  ${pressHtml}
  ${cateringHtml}
  ${orderHtml}
  ${bookingHtml}
  ${visitHtml}

  <footer>
    &copy; ${new Date().getFullYear()} ${name} &middot; Powered by <a href="https://siamepos.co.uk">SiamEPOS</a>
  </footer>
</body>
</html>`;
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
