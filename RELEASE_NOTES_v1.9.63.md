# SiamEPOS v1.9.63 — What's new

*Released 16–17 September 2026*

## Table check-back
Every course on the order screen now shows **🍽️ Arrived** (no need to press Call first) — tap it when the food is on the table. It then turns into **✓ Check back** — tap that once you've asked the table if everything is fine. The table on the floor map shows a **✓** so the whole team can see which tables have been checked. Works for starters, mains and desserts. Tap the stamp again to undo.

## Customer on the bill
A new **👤 Customer** button on every order (dine-in and takeaway). Search a guest you've served before, or type a name and phone. Their visits and spend then show correctly on the Customers tab — no more guessing by table and date.

## Online ordering switch
Admin → Settings → **Online Ordering ON/OFF**. Turn it off on a night you can't cope, and your website's order page and widget show "Online ordering is paused" — no new online orders come in. Bookings are not affected. Turn it back on when you're ready.

## After you've closed the day
Once the End of Day report is printed, ringing a new sale or changing a closed bill now asks for a **manager PIN** and warns that the printed report will no longer match. Stops the "my Z doesn't match" surprise.

## Remote support (Windows tills)
The till now sets up SiamEPOS remote support by itself the first time it starts after this update — Windows will ask once to allow it (click **Yes**). From then on, when you call us, we can see your screen and fix things without a visit; a notice shows on the till while we're connected. You'll find the details under Admin → Settings → **Remote support**. Share them only with SiamEPOS.

## Fixes
- **Reprinted bills** now show the booking deposit and balance due, exactly like the original bill.
- **Kitchen tickets for online orders** are sent more gently to the printer and retried once if the printer drops the connection — no more blank tickets on a busy printer. If it still can't print, the till shows a print alert instead of staying silent.
- Orders pushed to the cloud after a sync outage keep their **original date and time**.
- Website-chat and new-lead text alerts to you now actually send.

## What you need to do
- **Desktop till:** restart the app once (it updates itself on restart). On Windows, click **Yes** when it asks to allow remote support. If you use a second screen or tablets, restart those too.
- **Tablets / browser tills:** refresh the page once.
- Nothing else — your menu, tables and settings are untouched.

---

# SiamEPOS เวอร์ชัน 1.9.63 — มีอะไรใหม่

## เช็คแบ็กโต๊ะ (Check-back)
ทุกคอร์สในหน้าออเดอร์จะมีปุ่ม **🍽️ Arrived** (ไม่ต้องกดเรียกคอร์สก่อน) — กดเมื่ออาหารถึงโต๊ะ จากนั้นปุ่มจะเปลี่ยนเป็น **✓ Check back** — กดเมื่อถามลูกค้าแล้วว่าทุกอย่างเรียบร้อย โต๊ะบนแผนผังจะแสดงเครื่องหมาย **✓** ให้ทีมเห็นว่าโต๊ะไหนเช็คแล้ว ใช้ได้ทั้งของทานเล่น จานหลัก และของหวาน กดซ้ำเพื่อยกเลิก

## ระบุลูกค้าในบิล
ปุ่ม **👤 Customer** ในทุกออเดอร์ (ทานที่ร้านและสั่งกลับบ้าน) ค้นหาลูกค้าที่เคยมา หรือพิมพ์ชื่อและเบอร์ใหม่ ประวัติการมาและยอดใช้จ่ายจะขึ้นในหน้า Customers อย่างถูกต้อง ไม่ต้องเดาจากโต๊ะและวันที่อีกต่อไป

## สวิตช์เปิด/ปิดสั่งอาหารออนไลน์
Admin → Settings → **Online Ordering ON/OFF** คืนไหนรับไม่ไหวปิดได้เอง หน้าสั่งอาหารบนเว็บไซต์จะแสดงว่า "หยุดรับออเดอร์ออนไลน์ชั่วคราว" ไม่มีออเดอร์ใหม่เข้ามา การจองโต๊ะยังใช้ได้ตามปกติ เปิดกลับเมื่อพร้อม

## หลังปิดยอดวัน
เมื่อพิมพ์รายงาน End of Day แล้ว การเปิดออเดอร์ใหม่หรือแก้บิลที่ปิดแล้วจะขอ **PIN ผู้จัดการ** และเตือนว่ารายงานที่พิมพ์ไปจะไม่ตรงกับตัวเลขใหม่ ป้องกันปัญหา "ยอด Z ไม่ตรง"

## รีโมตซัพพอร์ต (เครื่อง Windows)
เครื่องแคชเชียร์จะตั้งค่ารีโมตซัพพอร์ตของ SiamEPOS ให้เองเมื่อเปิดครั้งแรกหลังอัปเดต — Windows จะถามอนุญาตหนึ่งครั้ง (กด **Yes**) จากนั้นเมื่อโทรหาเรา เราจะเห็นหน้าจอและแก้ปัญหาได้โดยไม่ต้องไปที่ร้าน ระหว่างเชื่อมต่อจะมีข้อความแจ้งบนจอ ดูรายละเอียดได้ที่ Admin → Settings → **Remote support** แชร์ข้อมูลนี้กับ SiamEPOS เท่านั้น

## แก้ไข
- **พิมพ์บิลซ้ำ** แสดงมัดจำและยอดคงเหลือเหมือนบิลต้นฉบับ
- **ตั๋วครัวของออเดอร์ออนไลน์** ส่งไปเครื่องพิมพ์แบบนุ่มนวลขึ้นและลองใหม่อัตโนมัติหนึ่งครั้งถ้าเครื่องพิมพ์หลุด — ไม่มีตั๋วเปล่าอีก ถ้ายังพิมพ์ไม่ได้ เครื่องจะแจ้งเตือนแทนที่จะเงียบ
- ออเดอร์ที่ส่งขึ้นคลาวด์หลังการซิงค์ขัดข้อง จะเก็บ**วันและเวลาเดิม**ไว้
- ข้อความแจ้งเตือนแชทเว็บไซต์และลูกค้าใหม่ส่งถึงคุณแล้ว

## สิ่งที่ต้องทำ
- **เครื่องแคชเชียร์:** ปิดแล้วเปิดแอปใหม่หนึ่งครั้ง (อัปเดตอัตโนมัติตอนเปิด) บน Windows กด **Yes** เมื่อถามอนุญาตรีโมตซัพพอร์ต ถ้ามีจอที่สองหรือแท็บเล็ต ให้เปิดใหม่ด้วย
- **แท็บเล็ต / เบราว์เซอร์:** รีเฟรชหน้าหนึ่งครั้ง
- แค่นั้น — เมนู โต๊ะ และการตั้งค่าไม่เปลี่ยน
