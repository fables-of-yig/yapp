/**
 * Encode/decode a server address into a 30-character alphanumeric code.
 *
 * Format: IP (4 bytes) + Port (2 bytes) + ServerID (8 bytes) = 14 bytes
 * → base62 encoded → padded/trimmed to 30 chars
 */

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = BigInt(CHARS.length);
const CODE_LEN = 30;

function ipToBytes(ip) {
  return ip.split('.').map(Number);
}

function bytesToIp(bytes) {
  return bytes.join('.');
}

function encode(ip, port, serverId) {
  const buf = Buffer.alloc(14);
  const parts = ipToBytes(ip);
  buf[0] = parts[0];
  buf[1] = parts[1];
  buf[2] = parts[2];
  buf[3] = parts[3];
  buf.writeUInt16BE(port, 4);
  // Write serverId as ASCII bytes (first 8 chars)
  const idStr = serverId.padEnd(8, '0').slice(0, 8);
  for (let i = 0; i < 8; i++) {
    buf[6 + i] = idStr.charCodeAt(i);
  }

  // Convert buffer to big integer
  let num = BigInt(0);
  for (let i = 0; i < buf.length; i++) {
    num = num * 256n + BigInt(buf[i]);
  }

  // Encode to base62
  let code = '';
  while (num > 0n) {
    code = CHARS[Number(num % BASE)] + code;
    num = num / BASE;
  }

  // Pad or trim to CODE_LEN
  while (code.length < CODE_LEN) code = '0' + code;
  return code.slice(0, CODE_LEN);
}

function decode(code) {
  if (code.length !== CODE_LEN) throw new Error('Invalid code length');

  // Decode from base62
  let num = BigInt(0);
  for (const ch of code) {
    const idx = CHARS.indexOf(ch);
    if (idx === -1) throw new Error('Invalid character in code');
    num = num * BASE + BigInt(idx);
  }

  // Convert back to bytes
  const buf = Buffer.alloc(14);
  for (let i = 13; i >= 0; i--) {
    buf[i] = Number(num & 0xFFn);
    num = num >> 8n;
  }

  const ip = bytesToIp([buf[0], buf[1], buf[2], buf[3]]);
  const port = buf.readUInt16BE(4);
  let serverId = '';
  for (let i = 6; i < 14; i++) {
    serverId += String.fromCharCode(buf[i]);
  }

  return { ip, port, serverId };
}

module.exports = { encode, decode };
