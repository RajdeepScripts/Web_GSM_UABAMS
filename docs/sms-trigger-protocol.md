# UABAMS → GSM/SMS Board Trigger Protocol

Spec for the data the UABAMS server sends to the STM32 + GSM-module board whenever a
qualifying impact event fires; the board decodes it and sends the SMS itself (via its own
AT-command link to the GSM modem).

**Current default: a simple ASCII `<EVENT>` frame.** This matches
`uabams_gsm_event_server.py`, a reference implementation a teammate built and validated
against the real board firmware — adopted here as the canonical protocol, reimplemented in
`web/server/smsGateway.js` (`buildEventFrame()`). An earlier, richer binary packet design
(fixed 131-byte struct, CRC16, embedded phone numbers) is kept in the same file as a dormant
alternative — see **Appendix: Binary Packet Format** below — selectable via
`SMS_WIRE_FORMAT=binary` in `.env` if the board's firmware is ever revisited to support it.
Everything in **Transport** below applies to both formats; only the payload differs.

## Transport

- **Protocol:** TCP.
- **Direction:** **Board → Server**. The board's firmware (`W5500_TCP_Client_Connect` /
  `W5500_Server_Receive_Task`) is a TCP *client* — it dials out to the UABAMS server's own
  IP:port (`g_server_ip`/`g_server_port` in its code) and then sits receive-only, waiting for
  data. The UABAMS server is the one listening; it does **not** open any connection to the
  board.
- **Server address (what the board dials):** the UABAMS server's own IP and port — the same
  `PORT` the web dashboard and the accelerometer/GPS boards already use (`5000`). No separate
  port or listener is needed.
- **How the server recognizes the board:** by source IP. `SMS_BOARD_IP` in the server's
  `.env` must match the IP the board connects *from* (its own static IP, `192.168.1.220`) —
  this is purely so the server can tell "this is the GSM board" apart from a web browser or
  an accelerometer board hitting the same port, since the GSM board never sends a
  recognizable first byte the way those do.
- **Connection lifetime:** the board's existing reconnect behavior (retry every 2s while
  `SOCK_CLOSED`) is exactly right — once connected, the server just keeps that socket and
  writes to it as impacts occur, for as long as the connection stays up. No connect/disconnect
  cycle per trigger.
- **Trigger:** sent once per qualifying impact event, same trigger/cooldown as the existing
  email alert (per-sensor cooldown, default 60s, configurable in the dashboard's Alert
  Settings panel). If the board isn't currently connected, the trigger is simply skipped and
  logged — no queueing, no retry of a missed trigger.
- **No response expected:** the board's firmware never sends anything back (`W5500_Send` is
  present but unused per its own comment, "GSM board mainly receives") — a successful write
  on the server's side is the only delivery signal there is.

## ASCII event frame (current default, `SMS_WIRE_FORMAT=ascii`)

```
<EVENT>\r\n
Phone=<number>\r\n
<one-line message>\r\n
</EVENT>\r\n
```

Based on `uabams_gsm_event_server.py`'s `send_gsm_event()`, extended with one line the
reference script didn't have: `Phone=<number>`, naming the SMS destination for this frame.
The GSM module's own number (whatever SIM is installed) is only the *sending* identity — it
can dial any destination via `AT+CMGS`, so the board needs this line to know who to actually
text, rather than relying on a number fixed in its own firmware. The board reads the `Phone=`
line for the destination, then sends the remaining line **verbatim as the SMS body**.
Firmware needs to: recognize `<EVENT>`, read the `Phone=` line and strip the prefix to get the
destination, read the next line as the literal SMS body, recognize `</EVENT>`.

**One frame per phone number.** The dashboard can have multiple numbers configured (Alert
Settings). Rather than pack them into one frame, `sendImpactSms()` writes one complete
`<EVENT>...</EVENT>` frame per number — same message, different `Phone=` line each time — so
each frame maps to exactly one SMS send on the board's side.

**Message format**, built by `buildEventFrame(phone, impact)` in `smsGateway.js`:
```
UABAMS HIGH-G P1;Sensor=<sensor>;Peak=<peakG>g;X=<x>,Y=<y>,Z=<z>;Time=<timestamp>
```
- `P1` is a **literal string, always**, matching the reference script exactly — it is not the
  impact's actual computed P-class (`P1`/`P2`/`P3`); every message says `P1` regardless of
  real severity. This is intentional, to keep the message text matching the reference
  implementation, not a bug.
- `sensor` — `left` / `right` / `pivot` / `aux`
- `peakG` — peak acceleration in g, 2 decimal places
- `x`/`y`/`z` — raw axis readings at the time of the impact, 2 decimal places
- `timestamp` — IST wall-clock string, as recorded for the impact

Example (full bytes, including the CRLFs), for one configured number:
```
<EVENT>\r\n
Phone=+919876543210\r\n
UABAMS HIGH-G P1;Sensor=right;Peak=8.42g;X=0.50,Y=1.20,Z=1.90;Time=2026-10-30T11:15:00.000\r\n
</EVENT>\r\n
```
With two numbers configured, the board receives two such frames back-to-back, one per number.

**Testing:** `node web/server/scripts/mock-sms-board.js` decodes this format by default —
connects to the server as a TCP client (same as the real board), prints the exact SMS body
text it would send for every event received.

## Suggested SMS text (reference, non-normative)

For comparison, the system's email alerts use a similar, denser one-liner:
```
[UABAMS] HIGH impact (P3) on right: 8.42g @3.215km
```
The ASCII event frame's message is deliberately close to the Python reference
implementation's format rather than this one — see above.

---

## Appendix: Binary Packet Format (legacy / dormant, `SMS_WIRE_FORMAT=binary`)

The original design, before `uabams_gsm_event_server.py` was adopted as the reference. Still
fully implemented in `smsGateway.js` (`buildPacket()`) and selectable via `.env`, but **not
the current default** — the board's firmware as shipped does not parse this format. Kept here
in case the firmware is revisited to support richer, per-trigger phone-number delivery.

### Byte order

**Little-endian** for every multi-byte field — the opposite of the existing server-facing TCP
accelerometer/GPS protocols (big-endian), chosen because this packet goes *to* an ARM
Cortex-M4 board: little-endian is the MCU's native byte order, so the whole packet can be
decoded with a single `memcpy` into a `__attribute__((packed))` struct with no manual
byte-swapping.

### Packet layout (131 bytes, fixed size)

| Offset | Size | Field        | Type        | Notes |
|-------:|-----:|--------------|-------------|-------|
| 0      | 1    | `sync0`      | `uint8_t`   | always `0xAC` |
| 1      | 1    | `sync1`      | `uint8_t`   | always `0x57` |
| 2      | 1    | `severity`   | `uint8_t`   | `1`=LOW, `2`=MEDIUM, `3`=HIGH |
| 3      | 1    | `pClass`     | `uint8_t`   | `0`=none, `1`=P1, `2`=P2, `3`=P3 |
| 4      | 1    | `sensorId`   | `uint8_t`   | `1`=left, `2`=right, `4`=pivot, `5`=aux (same codes as the existing MQTT binary packet `packetType` byte) |
| 5      | 1    | `phoneCount` | `uint8_t`   | how many of the 5 `phones[]` slots below are populated (0–5) |
| 6      | 4    | `peakG`      | `float32`   | peak acceleration, g |
| 10     | 4    | `distanceM`  | `float32`   | cumulative route distance at time of impact, metres |
| 14     | 4    | `latE6`      | `int32_t`   | latitude × 1,000,000; `0` if no GPS fix at time of impact |
| 18     | 4    | `lngE6`      | `int32_t`   | longitude × 1,000,000; `0` if no GPS fix |
| 22     | 1    | `hour`       | `uint8_t`   | IST wall-clock, 0–23 |
| 23     | 1    | `minute`     | `uint8_t`   | IST, 0–59 |
| 24     | 1    | `second`     | `uint8_t`   | IST, 0–59 |
| 25     | 1    | `day`        | `uint8_t`   | IST, 1–31 |
| 26     | 1    | `month`      | `uint8_t`   | IST, 1–12 |
| 27     | 2    | `year`       | `uint16_t`  | e.g. `2026` |
| 29     | 100  | `phones[5]`  | `char[5][20]` | 5 fixed 20-byte ASCII slots — see below |
| 129    | 2    | `crc16`      | `uint16_t`  | CRC16-CCITT over bytes 2–128 inclusive (see below) |

**Total: 131 bytes**, always sent at full fixed size regardless of `phoneCount` — unused
phone slots are all-zero. This keeps parsing trivial (one struct cast, no length math before
it's safe to read a given field).

### `phones[5]` encoding

Each of the 5 slots is a fixed 20-byte ASCII field: an optional leading `+`, followed by up
to 15 ASCII digits, **zero-padded on the right** to fill the 20 bytes. Numbers are always
shorter than 20 bytes (max valid length is 16: `+` plus 15 digits), so every slot is
guaranteed to end in at least 4 zero bytes — safe to treat as a null-terminated C string
directly with no extra bounds checking.

Only the first `phoneCount` slots are meaningful; ignore the rest (they'll be all-zero, i.e.
an empty string, but don't rely on that — check `phoneCount`).

### CRC16-CCITT

Same algorithm already used for the accelerometer and GPS binary packets elsewhere in this
system: polynomial `0x1021`, initial value `0xFFFF`, MSB-first, no final XOR. Computed over
bytes **2 through 128** (i.e. everything between the two sync bytes and the CRC field
itself — the sync bytes and the CRC field are *not* included in the CRC calculation).

Reference implementation (C, matches the server's JS implementation exactly):

```c
uint16_t crc16_ccitt(const uint8_t *buf, size_t len) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < len; i++) {
        crc ^= ((uint16_t)buf[i] << 8);
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        }
    }
    return crc;
}
```

Reject the packet (don't send an SMS) if the computed CRC doesn't match the trailing
`crc16` field — same validation the other boards' firmware already does on inbound packets.

### Example C struct

```c
#pragma pack(push, 1)
typedef struct {
    uint8_t  sync0;        // 0xAC
    uint8_t  sync1;        // 0x57
    uint8_t  severity;     // 1=LOW 2=MEDIUM 3=HIGH
    uint8_t  pClass;       // 0=none 1=P1 2=P2 3=P3
    uint8_t  sensorId;     // 1=left 2=right 4=pivot 5=aux
    uint8_t  phoneCount;   // 0-5
    float    peakG;
    float    distanceM;
    int32_t  latE6;
    int32_t  lngE6;
    uint8_t  hour;
    uint8_t  minute;
    uint8_t  second;
    uint8_t  day;
    uint8_t  month;
    uint16_t year;
    char     phones[5][20];
    uint16_t crc16;
} __attribute__((packed)) sms_trigger_packet_t;   // sizeof == 131
#pragma pack(pop)
```

```c
// Fits directly into the existing W5500_Server_Receive_Task() flow — once
// the socket reaches SOCK_ESTABLISHED, W5500_Recv() returns the bytes of
// one packet. No new logic needed beyond decoding it:
int received = W5500_Recv(sock, rx_buffer, buffer_size - 1);
if (received != sizeof(sms_trigger_packet_t)) {
    return; // partial/unexpected read — wait for the rest or drop it
}

sms_trigger_packet_t pkt;
memcpy(&pkt, rx_buffer, sizeof(pkt));

uint16_t calc_crc = crc16_ccitt(rx_buffer + 2, 127);  // bytes 2..128
if (pkt.sync0 != 0xAC || pkt.sync1 != 0x57 || calc_crc != pkt.crc16) {
    return; // drop malformed/corrupt packet
}

for (uint8_t i = 0; i < pkt.phoneCount && i < 5; i++) {
    // pkt.phones[i] is already a valid null-terminated C string
    send_sms(pkt.phones[i], build_message_text(&pkt));
}
```

### Example packet (annotated hex)

A HIGH/P3 impact on the right sensor, 8.42g, at 3215.4m, GPS fix at 28.584838°N 77.315866°E,
14:32:07 IST on 5 Oct 2026, sent to one number `+919876543210`:

```
AC 57                      sync0, sync1
03                         severity = 3 (HIGH)
03                         pClass = 3 (P3)
02                         sensorId = 2 (right)
01                         phoneCount = 1
... 4 bytes float32 LE ... peakG = 8.42
... 4 bytes float32 LE ... distanceM = 3215.4
... 4 bytes int32 LE ...   latE6 = 28584838
... 4 bytes int32 LE ...   lngE6 = 77315866
0E 20 07 05 0A D0 07       hour=14 min=32 sec=07 day=05 month=0A(10)... 
                           — illustrative only, see struct for exact field widths
2B 39 31 39 38 37 36 ...   phones[0] = "+919876543210" + zero padding to 20 bytes
00 00 00 00 ... (×4)       phones[1..4] = all-zero (unused)
... 2 bytes ...            crc16
```

(The hex above is illustrative of field order, not a byte-exact dump — compute the real
values from the struct layout table.)

Run `node web/server/scripts/mock-sms-board.js --binary` to test against this format instead
of the ASCII default.

## Questions / changes

If the board's firmware needs something different from either format above — flag it and the
server side will be updated to match. Both formats are implemented in `smsGateway.js` today;
switching between them is a one-line `.env` change (`SMS_WIRE_FORMAT`), no server code changes
needed either way.
