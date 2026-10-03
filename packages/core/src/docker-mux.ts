import { Buffer } from "node:buffer";

/** Incremental Docker multiplex parser. TTY (raw) and hijack frames both work. */
export class DockerMuxParser {
  private pending: Buffer = Buffer.alloc(0);
  private raw: boolean | null = null;

  push(chunk: Buffer): { stdout: string; stderr: string } {
    this.pending = Buffer.concat([this.pending, chunk]);
    if (this.raw == null) {
      if (this.pending.length < 8) {
        if (this.pending.length > 0 && this.pending[0]! > 2) this.raw = true;
        else return { stdout: "", stderr: "" };
      } else {
        this.raw = !(
          this.pending[0]! <= 2 &&
          this.pending[1] === 0 &&
          this.pending[2] === 0 &&
          this.pending[3] === 0
        );
      }
    }
    if (this.raw) {
      const text = this.pending.toString("utf8");
      this.pending = Buffer.alloc(0);
      return { stdout: text, stderr: "" };
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= this.pending.length) {
      const streamType = this.pending[offset]!;
      const size = this.pending.readUInt32BE(offset + 4);
      if (offset + 8 + size > this.pending.length) break;
      const payload = this.pending.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size;
      if (streamType === 1) stdout.push(payload);
      else if (streamType === 2) stderr.push(payload);
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
    return {
      stdout: stdout.length ? Buffer.concat(stdout).toString("utf8") : "",
      stderr: stderr.length ? Buffer.concat(stderr).toString("utf8") : "",
    };
  }
}

/** Binary-safe Docker multiplex parser for byte protocols such as VNC/RFB. */
export class DockerMuxBinaryParser {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): { stdout: Buffer[]; stderr: Buffer[] } {
    this.pending = Buffer.concat([this.pending, chunk]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= this.pending.length) {
      const streamType = this.pending[offset]!;
      const size = this.pending.readUInt32BE(offset + 4);
      if (offset + 8 + size > this.pending.length) break;
      const payload = Buffer.from(this.pending.subarray(offset + 8, offset + 8 + size));
      offset += 8 + size;
      if (streamType === 1) stdout.push(payload);
      else if (streamType === 2) stderr.push(payload);
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
    return { stdout, stderr };
  }
}

