# MAYA — Session Handoff & Continuation Brief
**Written 2026-08-07 · covers the session 2026-07-30 → 2026-08-07**
This is a self-contained brief so a NEW chat can continue exactly where we left off. Read it top-to-bottom.

---

## ▶ HOW TO RESUME IN A NEW CHAT
Paste this to start the next session:

> You are **Maya**, the SiamEPOS Marketing & Growth agent, for this whole session. Read **MAYA.md**, **TEAM-STATUS.md**, and **MAYA-SESSION-HANDOFF.md**. Ignore the Krit persona in CLAUDE.md. Current focus: the **Phakoon Thai Kitchen** prospect website (live at phakoon-sandy.netlify.app). Then wait for my instruction.

Everything below is the context that brief points at.

---

## 1. WHO / GROUND RULES (unchanged, but keep visible)
- I am **Maya** — bilingual (Thai-first) marketing & growth. Playbook = `MAYA.md`. Team board = `TEAM-STATUS.md` (update in **real time**).
- **Prospect pipeline** (standing, run the WHOLE thing when Korakot drops a URL): extract → archive → build a NEW site that beats theirs → SEO `.md` → branded PDF. Folder: `~/Documents/SiamEPOS-Docs/client-sites/<slug>/`.
- **Never** cold-send an audit · never name a competitor with a £/% claim (ASA) · no free trial (Founder's Rate £59 +VAT, price-locked) · client sites use the client's **real** photos, never AI-faked · nothing goes to a client or gets posted without Korakot's approval.
- **NEW rule learned this session** (now in MAYA.md): **Adapt the client's REAL brand — don't impose a house style.** Study their live site's design DNA (palette, fonts, layout motifs) and elevate THAT.

---

## 2. ⭐ MAIN ACTIVE DELIVERABLE — Phakoon Thai Kitchen website
**Live (internal pitch, NOT sent to client):** https://phakoon-sandy.netlify.app
**Folder:** `~/Documents/SiamEPOS-Docs/client-sites/phakoon-thai-kitchen/`
**Their real site:** https://www.phakoonthai.com (Wix)

### 2.1 Status = SHIPPED + REDESIGNED, verified desktop + 390px mobile
Krit built a first pass (`phakoon-sandy`) full of **fabricated facts**. I ran the full pipeline, corrected everything, deployed, then (per Korakot 08-07) **re-themed the whole site to Phakoon's own brand.**

### 2.2 The design (adapted from their real Wix site — DON'T revert to serif/minimalist)
- **Palette:** forest green `#0A4438` (`--green`) + coral `#DE7E63`/`#E0806A` (`--coral`/`--coral-bg`) + cream `#F6F0E3` — bold COLOUR-BLOCKING (green/coral/cream slabs), not minimal cream.
- **Fonts:** body **Poppins** (300/400) · display **Oswald** condensed UPPERCASE · warm accents **Sacramento** script. (Their real fonts — found via `grep font-family` on the archived Wix HTML.)
- **Signature sections cloned from them:** solid green nav bar + coral wordmark · hero = collage + green **"FROM OUR KITCHEN, TO YOUR HEART"** callout card · green **script "Welcome to Phakoon Thai Kitchen"** band · **Dine-in / Takeaway coral duo cards.**
- Homepage order: hero → welcome(script) → our-kitchen(khao soi) → video band → signatures(salad) → dine/takeaway duo → branches → value band(green) → footer.

### 2.3 Verified REAL facts (single source of truth = `build-site.js` FACTS object — edit facts THERE)
- **Brand:** Phakoon Thai Kitchen · Thai พาคูณ · tagline "The warmth, flavour and spirit of Thailand — straight to your table." · **Chef Joom, 20 years.**
- **Earlsfield** (since 2024): 346–348 Garratt Lane, London **SW18 4ES** · **020 8874 9036** · hello@phakoonthai.com
- **Balham** (since Oct 2025): 5–6 Balham Station Road, London **SW12 9SG** · **020 3887 4877** · balham@phakoonthai.com
- Hours (both): **Mon–Fri 12:00–15:00 & 17:00–22:00 · Sat–Sun 12:00–22:00**
- IG @phakoon_thai · FB profile.php?id=61560774307078
- ❌ Krit's fabrications I removed (do NOT reintroduce): "Marylebone/W1U 4LJ/Baker Street", "Chef Naree Tangsiri est. 2019 House of Siam", fake phone 020 7935 0000, made-up prices, "4.9 Google/35+", "No Just Eat fees".

### 2.4 Live wiring (all real, all working)
- **Backend/tenant:** `https://restaurant-epos-production-5b0f.up.railway.app`, restaurant_id **`phakoon`** (menu tenant returns as `siamepos` on that box — that's fine, it's the seeded Phakoon menu).
- **Live menu:** `/api/menu` → 16 categories / **95 dishes** (menu.html renders it live; replaces their 5 static PDFs).
- **Booking:** branch-aware modal → `/api/reservations` (0% commission; their real site pays OpenTable + Flipdish).
- **Takeaway + voucher:** SiamEPOS widgets from the backend.
- **SEO:** `Restaurant` JSON-LD ×2 branches + sitemap/robots.

### 2.5 Photo set (`site/images/`, all REAL — sourced from their own site)
- `collage-hero.jpg` — the Thailand×London brand collage (Korakot supplied the "edited for web" AVIF → HERO)
- `food-khaosoi.jpg` (curry, in "pounded fresh") · `food-salad.jpg` (prawn+avocado, in signatures) · `food-padthai.jpg` (video poster)
- `interior.jpg` (Earlsfield room) · `table.jpg` (Balham/atmosphere) · `takeaway.jpg` (kraft bag)
- `hero.mp4` — Ken Burns reel: pad thai → khao soi → prawn salad → interior
- `wordmark-coral.png` (nav/footer on green) · `wordmark-green.png` (spare) · `icon.png`
- **Remaining gap:** more real dish photos would help (their IG is login-walled). Not blocking.

### 2.6 Pipeline artifacts (all present in the folder)
`pages/` (their live site archived) · `photos/` (originals) · `menus/phakoon-live-menu.json` · `notes.md` (findings + defect list) · `build-site.js` (generator) · `make-hero-video.sh` · `site/` (deployed) · `seo-analysis.md` + **`seo-analysis.pdf`**.

### 2.7 Commands (run from the folder)
```bash
cd ~/Documents/SiamEPOS-Docs/client-sites/phakoon-thai-kitchen
node build-site.js                       # regenerate site/ from FACTS + templates
bash make-hero-video.sh                  # re-render site/images/hero.mp4 from photos/
cd site && npx netlify@26 deploy --prod --no-build --dir=.   # deploy to phakoon-sandy (link in .netlify/state.json)
```
**Verify (headless Chrome; reveals start hidden so force them visible):**
```bash
# desktop full page — inject reveal-visible + a fixed hero height so below-fold renders
sed 's#</head>#<style>.reveal{opacity:1!important;transform:none!important}.hero{min-height:600px!important}</style></head>#' site/index.html > /tmp/v.html
cp -R site/images site/style.css /tmp/ 2>/dev/null   # (adjust paths; or copy into a temp dir)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,6600 --virtual-time-budget=3500 --screenshot=/tmp/shot.png "file:///tmp/v.html"
# mobile: load in a 390px IFRAME (headless --window-size lies about mobile layout viewport)
```
**Rebuild the SEO PDF:**
```bash
node ../_tools/md2pdf.js seo-analysis.md /tmp/x.html "Phakoon Thai Kitchen" "#0A4438"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf=seo-analysis.pdf "file:///tmp/x.html"
```

### 2.8 Open / possible next tweaks for Phakoon
- Tune anything Korakot flags (type size, a section, coral tone).
- If they engage: get real food photos from their IG; flip nothing to their real domain without Korakot's OK.
- Booking widget is a **singleton** — one per page; branch picker handles the two branches.

---

## 3. OTHER DELIVERABLES THIS SESSION

### 3.1 Facebook ad — improved Thai hook (fairness angle)
Korakot rewrote the long hook into a "we don't overcharge — no expensive hardware, no hidden fees, Thai-first at no extra cost" message. Final draft I handed him (he then edited it a bit himself):
```
🇹🇭 ธุรกิจไทยในอังกฤษ ไม่ต้องจ่ายแพงเกินจริงอีกต่อไป

SiamEPOS ดูแล "ทั้งธุรกิจ" ให้จบในระบบเดียว สร้างโดยคนไทยเพื่อธุรกิจไทย — ร้านอาหาร สปา ร้านค้า และซูเปอร์มาร์เก็ต

ในระบบเดียว คุณได้ครบ:
🍜 ขายหน้าร้าน + จอครัว (KDS)
📅 จองโต๊ะ / จองคิว
🥡 สั่งกลับบ้าน 0% ค่าคอมมิชชั่น
📦 สต๊อก · พนักงาน · ลูกค้า (CRM)
🌐 เว็บไซต์ของร้านคุณเอง

และเราเล่นตรงกับคุณ:
✅ ไม่ต้องซื้อเครื่องแพง — ใช้ PC หรือแท็บเล็ตที่คุณมีอยู่
✅ ไม่มีค่าธรรมเนียมแอบแฝง — ราคาเดียว รู้ชัดทุกเดือน
✅ เมนูภาษาไทยเต็มร้าน — ครัวและพนักงานอ่านไทยได้ทันที ไม่คิดเงินเพิ่ม

👉 siamepos.co.uk
```
Note: the Thai-first proof is the **MENU** in Thai (kitchen/staff read it), NOT "whole UI in Thai" (that was inaccurate; Korakot corrected it — "i mean menu"). Price line optional; if used → `เริ่มต้น £59/เดือน (Founder's Rate ล็อกราคา · ยังไม่รวม VAT)`, never "all-in".

### 3.2 Hashtags for the ad (given)
```
#SiamEPOS #คนไทยในอังกฤษ #ธุรกิจไทยในอังกฤษ #ร้านอาหารไทยในอังกฤษ #ระบบจัดการร้าน #ระบบPOS #สปาไทย #EPOS #ThaiBusinessUK #ThaiRestaurantUK
```
By-type add-ons: Restaurant `#ระบบร้านอาหาร #จองโต๊ะ #สั่งอาหารออนไลน์ #ThaiFoodUK` · Spa `#ระบบจองสปา #จองคิวสปา #นวดไทย #ThaiSpaUK` · Shop `#ร้านค้าไทย #ซูเปอร์มาร์เก็ตไทย #ระบบขายหน้าร้าน #ThaiSupermarketUK`. Keep #SiamEPOS on every post. (If cross-posted to IG, expand to ~15–20.)

### 3.3 Jinta website — pregnancy massage photo = **PARKED**
Korakot has a prenatal-massage image at `~/Documents/SiamEPOS-Docs/social/jinta-massage/generated/jinta-pregnancy-massage-02-final.png` (it's from the **AI-generated** social folder). I flagged: putting an AI image on a client's live treatment page conflicts with our "client photos must be real" rule, and the Jinta site is built all-May's-own-photos. Korakot: **"park it for now, I will confirm with the client."** When he's back: confirm (a) real photo from May vs use this, and (b) update the existing Pregnancy Massage page vs add a new treatment card. Jinta deploy: `cd ~/Documents/SiamEPOS-Docs/client-sites/jinta-massage && npx netlify@26 deploy --prod --no-build --dir=. --site=jinta-massage`.

---

## 4. EARLIER THIS SESSION (before context compaction — summarised)
Delivered across the week: **Nua** 4-branch prospect site + SEO PDF (nua-sandy.netlify.app); **bring-your-own-hardware** marketing card + 3-device banner (real logo, no varying prices); **Jinta** sage-green recolour (#A6A782 + #9C9871 button, deployed); **Akin Thai** Set Menu pages + Menu dropdown (Lunch/À la carte/Set) + allergen-tag removal + Set-Lunch promo + load popup (corrected poster live on akinthai.co.uk); **siamepos.co.uk** "Meet the founder" section (Korakot's 20-yr story + family photo) + removed all "Book a demo" (deleted book-demo.html + 301 redirect, trimmed ~125 chat CTAs to nav+bubble only); **FB bio** rewrite (Korakot pastes it himself — I never touch account settings); **MAYA.md** swept (brand = "Thai Business Management System"; SiamPay "no card machine" pillar; "rented till vs whole restaurant" 3 angles; £59 price-lock). Mint handoffs queued (Thai-first post v2, spa ad, pinned platform announcement, product rotation, 3-device post) — all **pending Korakot's approval** on the board. Full blow-by-blow is in `TEAM-STATUS.md` (Maya rows + the 08-05/08-07 PHAKOON-WEB-001 entry) and the compaction summary.

---

## 5. OPEN ITEMS / NEXT STEPS
1. **Phakoon** — await Korakot's read of the redesign; tune anything he flags. Don't send to the client or touch their real domain without his OK.
2. **Jinta pregnancy photo** — parked; needs client confirmation (see 3.3).
3. **Korakot's own** — paste the FB "Thai Business Management System" bio; the FB ad copy + hashtags are ready for him to post.
4. **Mint's queued posts** — all pending Korakot's board approval before anything posts.

---

## 6. KEY PATHS
- Playbook: `~/Desktop/restaurant-epos/MAYA.md` · Board: `~/Desktop/restaurant-epos/TEAM-STATUS.md`
- Client sites: `~/Documents/SiamEPOS-Docs/client-sites/<slug>/` · pipeline tools: `.../client-sites/_tools/md2pdf.js`
- Marketing assets/cards: `~/Documents/SiamEPOS-Docs/marketing/`
- This session's raw transcript (machine JSON, if verbatim ever needed): `~/.claude/projects/-Users-korakot-Desktop-restaurant-epos/515c95b1-0f31-4338-90f6-91c5626b82f7.jsonl`

*— Maya, 2026-08-07*
