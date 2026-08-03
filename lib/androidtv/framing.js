'use strict';

/** Both Android TV protocols send length-delimited protobuf messages: a
 *  varint with the byte count, then the message itself.
 *
 *  The reference implementations assume that length always fits in a single
 *  byte, which quietly breaks on anything over 127 bytes — exactly what a
 *  message carrying typed text can be. So read the varint properly.
 */
class DelimitedReader {

  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /** Feed incoming bytes, get back every complete message in them. */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);

    const messages = [];
    for (;;) {
      const header = this.readVarint(0);
      if (!header) break;

      const end = header.bytes + header.value;
      if (this.buffer.length < end) break;

      messages.push(this.buffer.subarray(header.bytes, end));
      this.buffer = this.buffer.subarray(end);
    }
    return messages;
  }

  /** Returns { value, bytes } once the whole varint has arrived. */
  readVarint(offset) {
    let value = 0;
    let shift = 0;

    for (let i = offset; i < this.buffer.length; i += 1) {
      const byte = this.buffer[i];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return { value, bytes: i - offset + 1 };
      shift += 7;
      if (shift > 28) throw new Error('Varint van meer dan 5 bytes ontvangen');
    }
    return null;
  }
}

module.exports = { DelimitedReader };
