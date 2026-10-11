# Lab Watch

Tampermonkey userscript แจ้งเตือน (Windows toast + เสียง) เมื่อค่า Lab ใหม่ออกในหน้า
Routine ของ Lab Report (PTTGC) และเตือนเมื่อไม่ได้รับข้อมูลเกิน 20 นาที (session อาจหลุด)

> repo นี้เป็น **private** เพราะมีชื่อโดเมน intranet ของบริษัท อย่าเปลี่ยนเป็น public

## หลักการทำงาน

- hook `XMLHttpRequest`/`fetch` ของหน้าเว็บเอง อ่าน response `getReportResults` ที่เว็บโหลดอยู่แล้ว
  → **ไม่แตะ/ไม่เก็บ token** (เรียก API ตรงจากภายนอกได้ `401`)
- กดปุ่ม `OK` ในหน้าทุก 5 นาทีเพื่อให้เว็บโหลดข้อมูลใหม่
- เก็บสถานะใน `localStorage` ของ Edge เท่านั้น ไม่ส่งออกนอกเครื่อง ไม่เก็บ `analystId`

## ติดตั้ง (ทุกเครื่อง)

1. Edge: `edge://extensions` → เปิด **Developer mode**
2. ติดตั้ง Tampermonkey → Details → เปิด **Allow User Scripts** (ถ้าไม่เปิด สคริปต์จะไม่ถูกฉีด)
3. Tampermonkey → Create a new script → วางเนื้อหา `lab-watch.user.js` → `Ctrl+S`
4. เปิดหน้า Lab Report → กดปุ่ม **เปิดแจ้งเตือน** ในกล่อง Lab Watch → Allow
5. `edge://settings/system` → Sleeping tabs → ไม่ให้ `pttgclaro.pttgcgroup.com` หลับ

## ทดสอบ logic

```
node test.js
```

## ข้อจำกัด

- ต้องเปิดแท็บค้างไว้ และเครื่องห้าม sleep
- ถ้าเว็บเด้งไปหน้า login คนละโดเมน หรือ Edge แช่แข็งแท็บ จะเตือน session หลุดไม่ได้
- อัปเดตสคริปต์: แก้ไฟล์ใน repo แล้ว **ต้องวางทับใน Tampermonkey เอง** (ไม่ auto-sync)
