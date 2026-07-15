import http from "node:http";
import { Duplex } from "node:stream";

export function jsonRequest(app, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body || "";
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) { callback(); },
    });
    socket.remoteAddress = "127.0.0.1";
    const request = new http.IncomingMessage(socket);
    request.url = pathname;
    request.method = options.method || "GET";
    request.headers = {
      host: "aliashub.test",
      ...(payload ? {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      } : {}),
      ...options.headers,
    };
    const response = new http.ServerResponse(request);
    const chunks = [];
    let finished = false;
    response.write = function write(chunk, encoding, callback) {
      if (chunk) chunks.push(Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
      if (typeof encoding === "function") encoding();
      if (typeof callback === "function") callback();
      return true;
    };
    response.end = function end(chunk, encoding, callback) {
      if (chunk) chunks.push(Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
      if (typeof encoding === "function") encoding();
      if (typeof callback === "function") callback();
      this.finished = true;
      queueMicrotask(() => this.emit("finish"));
      return this;
    };
    response.on("finish", () => {
      if (finished) return;
      finished = true;
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({
        response: { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300 },
        body: text ? JSON.parse(text) : {},
      });
    });
    app.handle(request, response, (error) => {
      if (!finished) reject(error || new Error(`Unhandled request: ${request.method} ${pathname}`));
    });
    if (payload) request.push(payload);
    request.push(null);
  });
}
