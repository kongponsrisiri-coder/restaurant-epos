// SEPOS-WEB-001 — self-contained restaurant website generator.
// Returns a single HTML string with inline CSS and base64-embedded
// photos, so the generated file can be opened anywhere (or uploaded
// as-is to Netlify / their preferred host).

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

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

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${name}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${tagline}" />
  <style>
    :root { --primary: ${primary}; --primary-dark: ${primaryDark}; --accent: ${accent}; }
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; line-height: 1.6; }
    h1, h2, h3 { font-family: Georgia, 'Times New Roman', serif; line-height: 1.2; margin: 0 0 0.5em; }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 24px; }

    /* Top nav */
    .nav { position: sticky; top: 0; z-index: 50; background: rgba(255,255,255,0.97); border-bottom: 1px solid #eee; backdrop-filter: blur(8px); }
    .nav-inner { display: flex; align-items: center; padding: 14px 24px; max-width: 1100px; margin: 0 auto; }
    .nav-brand { font-family: Georgia, serif; font-weight: 700; font-size: 20px; color: var(--primary); letter-spacing: 0.5px; }
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
    .section-alt { background: #faf7f2; }
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

    /* Footer */
    footer { background: var(--primary-dark); color: rgba(255,255,255,0.78); text-align: center; padding: 28px 24px; font-size: 13px; }
    footer a { color: var(--accent); }

    /* Nav hide on small */
    @media (max-width: 600px) { .nav-links a:not(:last-child) { display: none; } }
  </style>
</head>
<body>
  <nav class="nav">
    <div class="nav-inner">
      <div class="nav-brand">${name}</div>
      <div class="nav-links">
        ${storyHtml    ? '<a href="#about">About</a>'       : ''}
        ${galleryHtml  ? '<a href="#gallery">Gallery</a>'   : ''}
        ${hoursHtml    ? '<a href="#hours">Hours</a>'       : ''}
        ${pressHtml    ? '<a href="#press">Press</a>'       : ''}
        ${cateringHtml ? '<a href="#catering">Catering</a>' : ''}
        ${visitHtml    ? '<a href="#visit">Visit</a>'       : ''}
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
  ${galleryHtml}
  ${hoursHtml}
  ${pressHtml}
  ${cateringHtml}
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
