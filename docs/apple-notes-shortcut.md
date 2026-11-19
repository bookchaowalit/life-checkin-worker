# ตั้ง iOS Shortcut ส่ง Apple Notes เข้า knowledge store (SPEC-004)

> **ฉบับร่าง:** route `/apple-notes` ยังไม่ได้ deploy ให้ทำตามคู่มือนี้หลังจาก SPEC-004 ได้รับอนุมัติและ deploy แล้ว

Shortcut นี้หาโน้ตในโฟลเดอร์ที่อนุญาตซึ่งถูกแก้ไขในช่วง 2 วันล่าสุด แล้วส่งไปที่
`https://solo-empire-checkin.bookchaowalit.workers.dev/apple-notes` ทีละโน้ต
โน้ตจะถูกเก็บเป็น Markdown แบบ private ที่ `knowledge-base:apple-notes/<note_id>.md`
อ่านได้จาก Knowledge Hub `/private` และจาก knowledge MCP

ข้อมูลไหลทางเดียวจาก iPhone ไปยังระบบ ถ้าแก้ไขในระบบ การแก้ไขนั้นจะถูกทับเมื่อโน้ตถูกแก้บน iPhone ครั้งถัดไป

## 0. สิ่งที่ต้องมี

- secret สำหรับ Shortcut: เปิด Infisical folder `/apple-notes` แล้วคัดลอกค่า `APPLE_NOTES_TOKEN`
- สร้างโฟลเดอร์ใน Notes ชื่อ **`Sync`** (ค่าเริ่มต้นตาม D-8) ระบบรับเฉพาะโน้ตในโฟลเดอร์ที่ตั้งไว้ใน `APPLE_NOTES_FOLDERS`
  ถ้าต้องการให้ sync โฟลเดอร์อื่นด้วย ต้องเพิ่มชื่อโฟลเดอร์ทั้งใน Shortcut และใน Worker var
- อย่าเก็บรหัสผ่านหรือ token ไว้ในโฟลเดอร์ที่ sync ระบบจะปฏิเสธโน้ตที่มีข้อความคล้าย secret (`secret-like`)

## 1. สร้าง Shortcut "ส่ง Apple Notes"

ในแอป Shortcuts กด **+** แล้วเพิ่ม action ตามลำดับนี้

**รับโน้ตจาก Share Sheet (ไม่บังคับ)**
1. เปิด Shortcut details (ไอคอน ⓘ) → เปิด **Show in Share Sheet** → Receive **Notes**
   ถ้าไม่มี input ให้ทำต่อที่ข้อ 2 ถ้ามี input ให้ส่งเฉพาะโน้ตนั้น (ใช้ action **If** `Shortcut Input` has any value)

**หาโน้ตที่เปลี่ยน**
2. **Date** → Current Date
3. **Adjust Date** → Subtract `2` days ตั้งชื่อตัวแปรว่า `Since`
   (ถ้ารันเองเพื่อส่งย้อนหลัง ให้เปลี่ยนเป็น **Ask for Input** ตัวเลข แล้วใช้เป็นจำนวนวัน)
4. **Find Notes** where
   - Folder **is** `Sync`
   - Last Modified Date **is after** `Since`
   - Sort by Last Modified Date, Oldest First
   ตั้งชื่อผลลัพธ์ว่า `Changed`

**ส่งทีละโน้ต**
5. **Repeat with Each** item in `Changed`
   1. **Make Markdown from Rich Text** (`Repeat Item` → Body) ตั้งชื่อว่า `BodyMd`
   2. **Format Date** (`Repeat Item` → Creation Date) → **ISO 8601**, Include Time ตั้งชื่อว่า `Created`
   3. **Format Date** (`Repeat Item` → Last Modified Date) → **ISO 8601**, Include Time ตั้งชื่อว่า `Modified`
   4. **Dictionary**
      - `created_at` (Text) = `Created`
      - `modified_at` (Text) = `Modified`
      - `folder` (Text) = `Repeat Item` → Folder
      - `title` (Text) = `Repeat Item` → Name
      - `body` (Text) = `BodyMd`
      - `pinned` (Boolean) = `Repeat Item` → Is Pinned
   5. **Get Contents of URL**
      - URL: `https://solo-empire-checkin.bookchaowalit.workers.dev/apple-notes`
      - Method: **POST**
      - Headers: `Authorization` = `Bearer <APPLE_NOTES_TOKEN>`
      - Request Body: **File** → `Dictionary` จากข้อ 5.4 (Shortcut จะส่งเป็น JSON)
   6. **Get Dictionary Value** → key `status` (ถ้าไม่มี ให้ใช้ key `error`) แล้ว **Add to Variable** `Results`
6. **End Repeat**
7. **Count** แต่ละค่าใน `Results` (created / updated / unchanged / อื่น ๆ) แล้ว **Show Notification** เช่น
   `Notes: ใหม่ 2 · อัปเดต 1 · ไม่เปลี่ยน 5 · ไม่สำเร็จ 0`

## 2. ตั้งให้รันเองทุกเช้า

Shortcuts → **Automation** → **+** → **Time of Day** 06:30, Daily → เลือก Shortcut "ส่ง Apple Notes"
→ เลือก **Run Immediately**

## 3. ผลลัพธ์ที่จะเห็น

| ผลลัพธ์ | ความหมาย |
|---|---|
| `created` / `updated` | บันทึกแล้ว (`version` คือเลข version ใน store) |
| `unchanged` | โน้ตนี้ไม่ได้เปลี่ยนตั้งแต่ส่งครั้งก่อน ส่งซ้ำได้ ไม่มีผลเสีย |
| HTTP 401 | secret ใน header ผิด |
| HTTP 403 `folder-not-allowed` | โฟลเดอร์ไม่อยู่ใน `APPLE_NOTES_FOLDERS` |
| HTTP 422 `empty` | เนื้อหาว่าง หรือเป็นโน้ตที่ล็อกไว้ (Shortcuts อ่านโน้ตที่ล็อกไม่ได้) |
| HTTP 422 `secret-like` | มีข้อความคล้าย key หรือ token ให้ย้ายไปไว้ใน Infisical หรือ password manager |
| HTTP 413 `too-large` | เนื้อหาเกิน 1 MiB |
| HTTP 502 `store` | knowledge store ตอบ error ให้รันใหม่ภายหลัง |

## ข้อจำกัด

- **KE-13:** ลบโน้ตบน iPhone แล้ว โน้ตในระบบจะยังอยู่
- **KE-14:** โน้ตสองโน้ตที่สร้างในวินาทีเดียวกัน (เช่น ทำซ้ำหรือ import) จะได้ id เดียวกัน
- **KE-15:** รูป ภาพวาด เอกสารสแกน และไฟล์แนบจะไม่ถูกส่ง ส่วน checklist และตารางจะกลายเป็นข้อความ Markdown
- **KE-16:** โน้ตที่ล็อกไว้ส่งไม่ได้
- **KE-18:** iOS อาจข้ามการรัน Automation ช่วงที่เครื่องล็อกหรือปิดอยู่ ถ้าข้ามไปหลายวัน ให้รัน Shortcut เองและเพิ่มจำนวนวันย้อนหลังในข้อ 3
