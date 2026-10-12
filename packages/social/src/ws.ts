// Minimal WebSocket client for Nostr relays. Uses the global WebSocket (Node ≥ 22) when there is one,
// otherwise a small RFC 6455 client over node:tls / node:net (text frames, masking, ping/pong, close).
import { randomBytes, createHash } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";

export interface WsConn {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  close(): void;
}

export type WsFactory = (url: string, timeoutMs?: number) => Promise<WsConn>;

export function defaultWsFactory(Impl?: unknown): WsFactory {
  const G = (Impl ?? (globalThis as any).WebSocket) as any;
  if (G) {
    return (url, timeoutMs = 10_000) =>
      new Promise((resolve, reject) => {
        const ws = new G(url);
        const listeners: ((d: string) => void)[] = [];
        const t = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error(`Timed out connecting to ${url}`));
        }, timeoutMs);
        ws.onopen = () => {
          clearTimeout(t);
          resolve({
            send: (d) => ws.send(d),
            onMessage: (cb) => listeners.push(cb),
            close: () => ws.close(),
          });
        };
        ws.onmessage = (ev: any) => {
          const d = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8");
          for (const l of listeners) l(d);
        };
        ws.onerror = (e: any) => {
          clearTimeout(t);
          reject(new Error(`WebSocket error on ${url}: ${e?.message ?? "connection failed"}`));
        };
      });
  }
  return builtinWs;
}

const builtinWs: WsFactory = (url, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const secure = u.protocol === "wss:";
    const port = Number(u.port || (secure ? 443 : 80));
    const key = randomBytes(16).toString("base64");
    const sock: Socket = secure ? tlsConnect({ host: u.hostname, port, servername: u.hostname }) : netConnect({ host: u.hostname, port });
    const listeners: ((d: string) => void)[] = [];
    let buf = Buffer.alloc(0);
    let open = false;
    let frag: Buffer[] = [];
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);
    sock.once(secure ? "secureConnect" : "connect", () => {
      sock.write(
        `GET ${u.pathname || "/"}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: claudia-social\r\n\r\n`,
      );
    });
    const write = (op: number, payload: Buffer) => {
      const mask = randomBytes(4);
      const len = payload.length;
      const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
      if (len >= 126 && len < 65536) {
        head[0] = 0x80 | op;
        head[1] = 0x80 | 126;
        head.writeUInt16BE(len, 2);
      } else if (len >= 65536) {
        head[0] = 0x80 | op;
        head[1] = 0x80 | 127;
        head.writeBigUInt64BE(BigInt(len), 2);
      }
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
      sock.write(Buffer.concat([head, mask, masked]));
    };
    const conn: WsConn = {
      send: (d) => write(0x1, Buffer.from(d, "utf8")),
      onMessage: (cb) => listeners.push(cb),
      close: () => {
        try {
          write(0x8, Buffer.alloc(0));
        } catch {
          /* ignore */
        }
        sock.end();
        setTimeout(() => sock.destroy(), 500).unref();
      },
    };
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString("latin1");
        buf = buf.subarray(end + 4);
        const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(accept.toLowerCase())) {
          clearTimeout(t);
          sock.destroy();
          reject(new Error(`${url} refused the WebSocket upgrade: ${head.split("\r\n")[0]}`));
          return;
        }
        open = true;
        clearTimeout(t);
        resolve(conn);
      }
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0]! & 0x80) !== 0;
        const op = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 0x9) write(0xa, Buffer.from(payload));
        else if (op === 0x8) sock.end();
        else if (op === 0x1 || op === 0x0) {
          frag.push(Buffer.from(payload));
          if (fin) {
            const text = Buffer.concat(frag).toString("utf8");
            frag = [];
            for (const l of listeners) l(text);
          }
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(t);
      if (!open) reject(e);
    });
  });
