#!/usr/bin/env node
// web/server/scripts/mock-sms-board.js
//
// Stands in for the real STM32 + GSM board's firmware while testing. Just
// like the real board, this connects OUT to the UABAMS server (it does NOT
// listen) and then sits there, receive-only, waiting for trigger events.
//
// Decodes the ASCII <EVENT>...</EVENT> frame (the current default wire
// format — see smsGateway.js's buildEventFrame / SMS_WIRE_FORMAT). Pass
// --binary to instead decode the legacy 131-byte binary packet format.
//
// IMPORTANT: for the real server to recognize this connection as "the GSM
// board" (instead of routing it through the normal HTTP/GPS/accel sniffing
// logic), SMS_BOARD_IP in the server's .env must match the IP this script
// actually connects FROM. For local testing that's usually 127.0.0.1 — set
// SMS_BOARD_IP=127.0.0.1 in web/server/.env and restart the service before
// running this.
//
// Usage:
//   node web/server/scripts/mock-sms-board.js [serverHost] [serverPort]
//   node web/server/scripts/mock-sms-board.js --binary [serverHost] [serverPort]
//   (defaults to 127.0.0.1:5000)

const net = require('net');
const { crc16Ccitt } = require('../smsGateway');

const argv = process.argv.slice(2);
const BINARY_MODE = argv.includes('--binary');
const positional = argv.filter(a => a !== '--binary');
const HOST = positional[0] || '127.0.0.1';
const PORT = parseInt(positional[1]) || 5000;
const PACKET_SIZE = 131;

const SEVERITY_NAME = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH' };
const PCLASS_NAME   = { 0: '-', 1: 'P1', 2: 'P2', 3: 'P3' };
const SENSOR_NAME   = { 1: 'left', 2: 'right', 4: 'pivot', 5: 'aux' };

function decodeBinary(buf) {
    const sync0 = buf.readUInt8(0), sync1 = buf.readUInt8(1);
    const severity = buf.readUInt8(2);
    const pClass = buf.readUInt8(3);
    const sensorId = buf.readUInt8(4);
    const phoneCount = buf.readUInt8(5);
    const peakG = buf.readFloatLE(6);
    const distanceM = buf.readFloatLE(10);
    const latE6 = buf.readInt32LE(14);
    const lngE6 = buf.readInt32LE(18);
    const hour = buf.readUInt8(22), minute = buf.readUInt8(23), second = buf.readUInt8(24);
    const day = buf.readUInt8(25), month = buf.readUInt8(26), year = buf.readUInt16LE(27);

    const phones = [];
    for (let i = 0; i < 5; i++) {
        const start = 29 + i * 20;
        const raw = buf.subarray(start, start + 20).toString('ascii').replace(/\0+$/, '');
        if (raw) phones.push(raw);
    }

    const crcField = buf.readUInt16LE(PACKET_SIZE - 2);
    const crcCalc = crc16Ccitt(buf.subarray(2, PACKET_SIZE - 2));

    return {
        syncOk: sync0 === 0xAC && sync1 === 0x57,
        crcOk: crcField === crcCalc,
        severity: SEVERITY_NAME[severity] || `unknown(${severity})`,
        pClass: PCLASS_NAME[pClass] ?? `unknown(${pClass})`,
        sensor: SENSOR_NAME[sensorId] || `unknown(${sensorId})`,
        phoneCount, peakG, distanceM,
        lat: latE6 / 1e6, lng: lngE6 / 1e6,
        timeIst: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
        phones,
    };
}

function handleBinaryPacket(buf) {
    if (buf.length !== PACKET_SIZE) {
        console.log(`[mock-board] ✗ expected ${PACKET_SIZE} bytes, got ${buf.length} — dropping`);
        return;
    }
    const pkt = decodeBinary(buf);
    if (!pkt.syncOk) { console.log('[mock-board] ✗ bad sync bytes — dropping'); return; }
    if (!pkt.crcOk)  { console.log('[mock-board] ✗ CRC mismatch — dropping'); return; }

    console.log('[mock-board] ✓ valid binary packet:');
    console.log(`  ${pkt.severity} impact (${pkt.pClass}) on ${pkt.sensor} — ${pkt.peakG.toFixed(2)}g @ ${(pkt.distanceM / 1000).toFixed(3)}km`);
    console.log(`  GPS: ${pkt.lat.toFixed(6)}, ${pkt.lng.toFixed(6)}   Time (IST): ${pkt.timeIst}`);
    console.log(`  Would SMS ${pkt.phoneCount} number(s): ${pkt.phones.join(', ') || '(none)'}`);
}

// ASCII mode: accumulate text and split on <EVENT>...</EVENT> frames. Each
// frame carries a Phone= line naming its destination, then the SMS body.
function handleAsciiChunk(textBuf) {
    let text = textBuf.toString();
    let frame;
    const re = /<EVENT>\r?\n([\s\S]*?)\r?\n<\/EVENT>\r?\n/;
    while ((frame = re.exec(text))) {
        const lines = frame[1].split(/\r?\n/);
        const phoneLine = lines.find(l => l.startsWith('Phone='));
        const phone = phoneLine ? phoneLine.slice('Phone='.length) : null;
        const message = lines.filter(l => !l.startsWith('Phone=')).join('\n');
        console.log('[mock-board] ✓ valid ASCII event frame:');
        if (phone) console.log(`  Destination: ${phone}`);
        else console.log('  ⚠ no Phone= line found — falling back to board\'s own configured number, if any');
        console.log(`  SMS body (verbatim, as the board would send it): "${message}"`);
        text = text.slice(frame.index + frame[0].length);
        re.lastIndex = 0;
    }
    return Buffer.from(text); // leftover partial frame, kept for next chunk
}

function connect() {
    const sock = net.connect(PORT, HOST, () => {
        console.log(`[mock-board] connected to ${HOST}:${PORT} — waiting for trigger ${BINARY_MODE ? 'packets' : 'events'} (receive-only, same as the real board)`);
    });

    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        if (BINARY_MODE) {
            while (buf.length >= PACKET_SIZE) {
                handleBinaryPacket(buf.subarray(0, PACKET_SIZE));
                buf = buf.subarray(PACKET_SIZE);
            }
        } else {
            buf = handleAsciiChunk(buf);
        }
    });
    sock.on('error', e => console.error('[mock-board] connection error:', e.message));
    sock.on('close', () => {
        console.log('[mock-board] disconnected — retrying in 2s (mirrors the real firmware\'s reconnect loop)');
        setTimeout(connect, 2000);
    });
}

console.log(`[mock-board] mode: ${BINARY_MODE ? 'binary (131-byte packet)' : 'ascii (<EVENT> frame, default)'}`);
connect();
