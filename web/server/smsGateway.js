// web/server/smsGateway.js
//
// Sends impact-alert SMS triggers to the STM32 + GSM-module board.
//
// The board's firmware is a TCP *client* — it dials out to this server's
// own IP:PORT (the same port server.js already listens on for the web UI
// and the accel/GPS boards) and then just sits there, receive-only, never
// sending anything itself. So instead of us connecting out to the board
// (which its firmware was never written to accept), server.js's tcpMux
// recognizes that inbound connection by source IP (see handleSmsBoardSocket
// in server.js), hands the live socket to this module via setBoardSocket(),
// and we simply write to that already-open connection whenever an impact
// fires. No firmware changes required.
//
// WIRE FORMAT: as of this change, the default on-wire format is a simple
// ASCII frame — <EVENT>\r\n<one-line message>\r\n</EVENT>\r\n — matching
// uabams_gsm_event_server.py (a reference implementation a teammate built
// and proved working against the real board). The board apparently just
// extracts whatever's between the <EVENT>/</EVENT> markers and sends it
// verbatim as the SMS body — it does not parse individual fields — so the
// message text below is deliberately close to that script's format for
// consistency, using OUR already-computed severity/P-class (that script
// hardcoded the literal string "P1" regardless of actual severity; here we
// use the real value).
//
// IMPORTANT: this ASCII format carries NO phone numbers — unlike the
// original binary-packet design (kept below, dormant, as buildPacket()),
// it assumes the board has its own recipient number(s) configured on its
// own side. The phone numbers configured in the dashboard's Alert Settings
// are therefore NOT currently transmitted to the board; see the log note
// in sendImpactSms() below.
//
// Switch wire formats via .env: SMS_WIRE_FORMAT=ascii (default) | binary.
// Full spec: /docs/sms-trigger-protocol.md

const SMS_WIRE_FORMAT = (process.env.SMS_WIRE_FORMAT || 'ascii').toLowerCase();

const MAX_PHONES = 5;
const PHONE_FIELD_LEN = 20;

const SYNC0 = 0xAC, SYNC1 = 0x57;
const PACKET_SIZE = 131; // 2 sync + 4 header + 16 numeric + 6 datetime + 100 phones + 2 crc

const SEVERITY_CODE = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const PCLASS_CODE   = { P1: 1, P2: 2, P3: 3 };
const SENSOR_CODE   = { left: 1, right: 2, pivot: 4, aux: 5 };

// Same CRC16-CCITT (poly 0x1021, init 0xFFFF, MSB-first) as crc16Ccitt() in
// server.js — duplicated here rather than imported to keep this module
// require()-able standalone, without creating a circular dependency back on
// server.js. Only used by the (dormant-by-default) binary wire format.
function crc16Ccitt(buf) {
    let crc = 0xFFFF;
    for (const b of buf) {
        crc ^= (b << 8);
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xFFFF;
        }
    }
    return crc;
}

// impact.timestamp is already an IST wall-clock string from
// getTimezoneTimestamp() — "yyyy-MM-dd'T'HH:mm:ss.SSS" — so this just
// splits it apart rather than re-deriving the timezone.
function parseIstTimestamp(ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(ts || '');
    if (!m) {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate(),
                  hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() };
    }
    const [, year, month, day, hour, minute, second] = m;
    return { year: +year, month: +month, day: +day, hour: +hour, minute: +minute, second: +second };
}

// ── ASCII event frame (current default) ────────────────────────────────────
// Based on uabams_gsm_event_server.py's send_gsm_event(): a human-readable
// message wrapped in <EVENT>/</EVENT> markers, CRLF-terminated. Extended
// with one line the reference script didn't have — Phone=<number> — naming
// the SMS destination for this frame. The GSM module's own number
// (whatever SIM is installed) is only the sending identity; it can dial
// any destination via AT+CMGS, so the board needs this line to know who to
// actually text instead of relying on a number fixed in its own firmware.
// Each frame carries exactly one phone number and one message — for a
// sensor with multiple configured numbers, sendImpactSms() writes one
// frame per number (see below).
function buildEventFrame(phone, impact) {
    try {
        const peakG = Number(impact.peak_g ?? impact.gForce ?? 0) || 0;
        const x = Number(impact.x ?? 0) || 0, y = Number(impact.y ?? 0) || 0, z = Number(impact.z ?? 0) || 0;
        // Reference script hardcodes the literal "P1" here regardless of
        // actual severity/P-class — matched exactly, not using our real
        // computed pClass, so the message text is otherwise byte-for-byte
        // identical to uabams_gsm_event_server.py's output.
        const message =
            `UABAMS HIGH-G P1;Sensor=${impact.sensor};Peak=${peakG.toFixed(2)}g;` +
            `X=${x.toFixed(2)},Y=${y.toFixed(2)},Z=${z.toFixed(2)};Time=${impact.timestamp}`;
        return Buffer.from(`<EVENT>\r\nPhone=${phone}\r\n${message}\r\n</EVENT>\r\n`, 'ascii');
    } catch (e) {
        // Matches buildPacket()'s contract — degrade to null on any
        // unexpected input rather than let sendImpactSms() throw.
        console.error('[sms] buildEventFrame error:', e.message);
        return null;
    }
}

// ── Binary packet (legacy/dormant) ──────────────────────────────────────────
// The original design: a fixed 131-byte struct with sync bytes, CRC16, and
// up to 5 phone numbers embedded in the packet itself. Kept in place and
// still fully working (see docs/sms-trigger-protocol.md, appendix) in case
// the board's firmware is ever revisited to parse this richer format
// instead. Not used unless SMS_WIRE_FORMAT=binary.
function buildPacket(phones, impact, gpsCoord) {
    try {
        const buf = Buffer.alloc(PACKET_SIZE); // zero-filled, so unused phone slots are already all-zero
        let off = 0;

        buf.writeUInt8(SYNC0, off); off += 1;
        buf.writeUInt8(SYNC1, off); off += 1;
        buf.writeUInt8(SEVERITY_CODE[impact.severity] || 0, off); off += 1;
        buf.writeUInt8(PCLASS_CODE[impact.p_class] || 0, off); off += 1;
        buf.writeUInt8(SENSOR_CODE[impact.sensor] || 0, off); off += 1;

        const usedPhones = (phones || []).slice(0, MAX_PHONES);
        buf.writeUInt8(usedPhones.length, off); off += 1;

        buf.writeFloatLE(impact.peak_g ?? impact.gForce ?? 0, off); off += 4;
        buf.writeFloatLE(impact.distance_m ?? 0, off); off += 4;

        const lat = gpsCoord?.lat, lng = gpsCoord?.lng;
        buf.writeInt32LE(lat ? Math.round(lat * 1e6) : 0, off); off += 4;
        buf.writeInt32LE(lng ? Math.round(lng * 1e6) : 0, off); off += 4;

        const t = parseIstTimestamp(impact.timestamp);
        buf.writeUInt8(t.hour, off); off += 1;
        buf.writeUInt8(t.minute, off); off += 1;
        buf.writeUInt8(t.second, off); off += 1;
        buf.writeUInt8(t.day, off); off += 1;
        buf.writeUInt8(t.month, off); off += 1;
        buf.writeUInt16LE(t.year, off); off += 2;

        for (let i = 0; i < MAX_PHONES; i++) {
            if (i < usedPhones.length) {
                buf.write(usedPhones[i].slice(0, PHONE_FIELD_LEN), off, PHONE_FIELD_LEN, 'ascii');
            }
            off += PHONE_FIELD_LEN;
        }

        const crc = crc16Ccitt(buf.subarray(2, PACKET_SIZE - 2)); // bytes 2..128
        buf.writeUInt16LE(crc, PACKET_SIZE - 2);

        return buf;
    } catch (e) {
        console.error('[sms] buildPacket error:', e.message);
        return null;
    }
}

// The board's own inbound connection, handed to us by server.js's tcpMux
// once it recognizes the connecting IP as the configured SMS_BOARD_IP.
// Null whenever the board isn't currently connected. Also tracked here:
// connection/trigger history, purely so getStatus() can answer "is it
// connected, and did the last trigger actually go out" without anyone
// having to grep the log file.
let boardSocket = null;
let connectedAt = null;
let remoteIP = null;
let lastTrigger = null; // { at, sensor, ok, reason }

function setBoardSocket(sock) {
    if (boardSocket && boardSocket !== sock && !boardSocket.destroyed) {
        boardSocket.destroy(); // replace any stale prior connection from the same board
    }
    boardSocket = sock;
    connectedAt = new Date().toISOString();
    remoteIP = (sock.remoteAddress || '').replace('::ffff:', '');
}

function clearBoardSocket(sock) {
    if (boardSocket === sock) {
        boardSocket = null;
        connectedAt = null;
        remoteIP = null;
    }
}

// Current state for a status check — e.g. GET /api/sms-board/status — so
// "is the board connected, and did the last trigger actually get sent" can
// be answered at a glance instead of tailing the log.
function getStatus() {
    return {
        connected: !!(boardSocket && !boardSocket.destroyed),
        remoteIP,
        connectedAt,
        wireFormat: SMS_WIRE_FORMAT,
        lastTrigger,
    };
}

// Writes one already-built payload to the board's open socket and updates
// lastTrigger with the outcome. Shared by both wire formats below — the
// only difference between them is how many times this gets called and
// what's in the payload.
function writeToBoard(payload, sensor, phoneLabel) {
    return new Promise(resolve => {
        boardSocket.write(payload, (err) => {
            if (err) {
                console.error(`[sms] SMS send FAILED for ${sensor} → ${phoneLabel}: ${err.message}`);
                lastTrigger = { at: new Date().toISOString(), sensor, ok: false, reason: err.message };
            } else {
                // The one line to grep/watch for — explicitly names which
                // number the dashboard-configured alert was sent to.
                console.log(`[sms] SMS sent to ${phoneLabel} for ${sensor} impact (${SMS_WIRE_FORMAT} format, ${payload.length} bytes)`);
                lastTrigger = { at: new Date().toISOString(), sensor, ok: true, reason: null };
            }
            resolve();
        });
    });
}

// Sends one impact-alert trigger to the GSM board over whatever connection
// it currently has open to us. Fire-and-forget, never throws — SMS
// delivery is best-effort and must never block or break the email alert
// path it rides alongside in maybeSendImpactEmail().
async function sendImpactSms(phones, impact, gpsCoord) {
    if (!phones || !phones.length) return;
    if (!boardSocket || boardSocket.destroyed) {
        console.warn('[sms] GSM board not currently connected — skipping SMS trigger');
        lastTrigger = { at: new Date().toISOString(), sensor: impact.sensor, ok: false, reason: 'board not connected' };
        return;
    }

    if (SMS_WIRE_FORMAT === 'binary') {
        if (phones.length > MAX_PHONES) {
            console.warn(`[sms] ${phones.length} phones configured, only the first ${MAX_PHONES} fit in one packet`);
        }
        const payload = buildPacket(phones, impact, gpsCoord);
        if (!payload) {
            lastTrigger = { at: new Date().toISOString(), sensor: impact.sensor, ok: false, reason: 'payload build failed' };
            return;
        }
        await writeToBoard(payload, impact.sensor, phones.join(', '));
        return;
    }

    // ASCII format: one frame per phone number, each naming its own
    // destination via the Phone= line — see buildEventFrame().
    for (const phone of phones) {
        if (typeof phone !== 'string' || !PHONE_RE.test(phone)) {
            console.warn(`[sms] Skipping invalid phone value: ${JSON.stringify(phone)}`);
            continue;
        }
        const frame = buildEventFrame(phone, impact);
        if (!frame) {
            lastTrigger = { at: new Date().toISOString(), sensor: impact.sensor, ok: false, reason: 'payload build failed' };
            continue;
        }
        await writeToBoard(frame, impact.sensor, phone);
    }
}

// ── Phone-number push ───────────────────────────────────────────────────────
// When a number is entered in the dashboard's Alert Settings, it's pushed to
// the board straight away, one frame per number:
//   <PHONE>\r\n+919876543210\r\n</PHONE>\r\n
// Returns the list of numbers actually written (empty if not connected).
function buildPhoneFrame(phone) {
    return Buffer.from(`<PHONE>\r\n${phone}\r\n</PHONE>\r\n`, 'ascii');
}

const PHONE_RE = /^\+?[0-9]{7,15}$/;

async function sendPhoneNumbers(phones) {
    // Defence in depth: never write anything but a plain number into a frame.
    phones = (phones || []).filter(p => {
        const ok = typeof p === 'string' && PHONE_RE.test(p);
        if (!ok) console.warn(`[sms] Refusing to push invalid phone value: ${JSON.stringify(p)}`);
        return ok;
    });
    if (!phones.length) return [];
    if (!boardSocket || boardSocket.destroyed) {
        console.warn(`[sms] GSM board not connected — could not push number(s): ${phones.join(', ')}`);
        return [];
    }
    const sent = [];
    for (const phone of phones) {
        const ok = await new Promise(resolve => {
            boardSocket.write(buildPhoneFrame(phone), err => {
                if (err) console.error(`[sms] Phone push FAILED for ${phone}: ${err.message}`);
                else console.log(`[sms] Phone number ${phone} sent to GSM board`);
                resolve(!err);
            });
        });
        if (ok) sent.push(phone);
    }
    return sent;
}

module.exports = {
    sendImpactSms, sendPhoneNumbers, buildPhoneFrame, buildPacket, buildEventFrame, crc16Ccitt,
    setBoardSocket, clearBoardSocket, getStatus,
};
