# ตั้ง iOS Shortcut ส่ง Apple Health เข้า health cell (SPEC-003)

Shortcut นี้อ่านค่ารวมของ **เมื่อวาน** จากแอป Health แล้วส่งไปที่
`https://solo-empire-checkin.bookchaowalit.workers.dev/apple-health` ทุกเช้า 07:00
ค่าที่ส่งจะไปอยู่ใน health cell โดยมี `source = apple-health` และ morning brief จะแสดงค่าเหล่านี้ให้เอง

## 0. สิ่งที่ต้องมี

- secret สำหรับ Shortcut: เปิด Infisical folder `/apple-health` แล้วคัดลอกค่า `APPLE_HEALTH_TOKEN` (ใช้แอปหรือหน้าเว็บ Infisical บน iPhone)
- ให้สิทธิ์ Shortcuts อ่าน Health: ระบบจะถามตอนรันครั้งแรก ให้กด Allow ทุกประเภทข้อมูลที่ใช้

## 1. สร้าง Shortcut "ส่ง Apple Health"

ในแอป Shortcuts กด **+** แล้วเพิ่ม action ตามลำดับนี้

**วันที่**
1. **Date** → Current Date
2. **Adjust Date** → Subtract `1` day ตั้งชื่อตัวแปรว่า `Yesterday`
3. **Format Date** (`Yesterday`) → Custom `yyyy-MM-dd` ตั้งชื่อตัวแปรว่า `DateText`
4. **Get Dates from Input** (`DateText`) ตั้งชื่อตัวแปรว่า `DayStart` (คือเที่ยงคืนต้นวันของเมื่อวาน)
5. **Adjust Date** (`DayStart`) → Add `1` day ตั้งชื่อตัวแปรว่า `DayEnd`

**ค่าแบบผลรวมทั้งวัน** ทำซ้ำชุดนี้กับแต่ละประเภท
6. **Find Health Samples** → Type = *Steps*, Start Date **is between** `DayStart` and `DayEnd`
7. **Calculate Statistics** → **Sum** ของผลลัพธ์ ตั้งชื่อตัวแปรว่า `Steps`

ใช้วิธีเดียวกันกับประเภทเหล่านี้ (ใช้ Sum ทั้งหมด)

| Health type | ชื่อตัวแปร | key ใน JSON |
|---|---|---|
| Active Energy | `ActiveEnergy` | `active_energy` (kcal) |
| Exercise Minutes | `ExerciseMin` | `exercise_minutes` |
| Walking + Running Distance (หน่วย km) | `Distance` | `walking_distance` |

**ค่าเฉลี่ยหรือค่าล่าสุดของวัน** ใช้ Calculate Statistics → **Average**

| Health type | ชื่อตัวแปร | key |
|---|---|---|
| Heart Rate | `HRAvg` | `heart_rate_avg` |
| Heart Rate Variability | `HRV` | `hrv` |
| Resting Heart Rate | `RestingHR` | `resting_heart_rate` |
| Weight (หน่วย kg) | `Weight` | `weight` |

**การนอน** (คืนที่จบในเช้าวันนั้น)
8. **Adjust Date** (`DayStart`) → Subtract `6` hours ตั้งชื่อว่า `SleepFrom` (18:00 ของวันก่อนหน้า)
9. **Adjust Date** (`DayStart`) → Add `14` hours ตั้งชื่อว่า `SleepTo` (14:00)
10. **Find Health Samples** → Type = *Sleep Analysis*, Value **is not** *In Bed* และ *Awake*, Start Date between `SleepFrom` and `SleepTo`
11. **Get Details of Health Sample** → **Duration**
12. **Calculate Statistics** → **Sum**
13. **Calculate** → ÷ `3600` (ถ้า Duration ออกมาเป็นวินาที) ตั้งชื่อว่า `SleepHours`

> หากวันไหนไม่มีข้อมูล ปล่อยค่าว่างไว้ได้ Worker จะข้ามค่าว่างไปเอง ไม่นับว่า error
> ตัวเลขที่ใช้ลูกน้ำเป็นทศนิยม เช่น `7,25` ก็อ่านได้ แต่ห้ามมีตัวคั่นหลักพัน (เช่น `8,412` ก้าว จะถูกปฏิเสธ)
> ให้ตั้ง Format Number → Decimal Places ตามต้องการ และปิด grouping

**ส่งข้อมูล**
14. **Dictionary**
    - `date` (Text) = `DateText`
    - `metrics` (Dictionary):
      `steps` = `Steps`, `sleep_hours` = `SleepHours`, `resting_heart_rate` = `RestingHR`,
      `heart_rate_avg` = `HRAvg`, `hrv` = `HRV`, `active_energy` = `ActiveEnergy`,
      `exercise_minutes` = `ExerciseMin`, `walking_distance` = `Distance`, `weight` = `Weight`
      (ทุกช่องเลือกประเภท Number)
15. **Get Contents of URL**
    - URL: `https://solo-empire-checkin.bookchaowalit.workers.dev/apple-health`
    - Method: **POST**
    - Headers: `Authorization` = `Bearer <APPLE_HEALTH_TOKEN>`
    - Request Body: **File** → `Dictionary` จากข้อ 14 (Shortcut จะส่งเป็น JSON)
16. **Get Dictionary Value** → key `message`
17. **Show Notification** → ข้อความจากข้อ 16

## 2. ตั้งให้รันเองทุกเช้า

Shortcuts → **Automation** → **+** → **Time of Day** 07:00, Daily → เลือก Shortcut "ส่ง Apple Health"
→ เลือก **Run Immediately** และปิด Notify When Run หากไม่ต้องการแจ้งเตือนซ้อน

## 3. ผลลัพธ์ที่จะเห็น

| ข้อความ | ความหมาย |
|---|---|
| `✅ บันทึก Apple Health N ค่า · <วัน>` | บันทึกครบทุกค่า |
| `⚠️ … ไม่สำเร็จ N` (HTTP 502) | health cell ตอบ error ให้รัน Shortcut ใหม่ภายหลังได้ ค่าที่บันทึกไปแล้วจะไม่ซ้ำ |
| `⚠️ … อ่านไม่ได้ N` (HTTP 422) | ไม่มีค่าที่บันทึกได้เลย ให้ดู `rejected` ในผลลัพธ์ |
| HTTP 401 | secret ใน header ผิด |
| HTTP 400 `invalid-date` | `date` ต้องเป็น `yyyy-MM-dd` และย้อนหลังได้ไม่เกิน 31 วัน |

## ข้อจำกัด

- **KE-11:** ถ้าแก้ค่าใน Health หลังจาก Shortcut รันไปแล้ว ค่าในระบบจะไม่ถูกอัปเดต (ระบบเก็บค่าแรกของแต่ละวัน)
- **KE-12:** iOS อาจข้ามการรัน Automation ถ้าเครื่องไม่ได้ใช้งานในช่วงเวลานั้น วันที่ข้ามไปจะไม่ถูกส่งย้อนหลังให้เอง ถ้าต้องการส่งย้อนหลัง ให้รัน Shortcut เองโดยแก้ข้อ 2 ให้ลบจำนวนวันตามที่ต้องการ
