/**
 * Small HTTP helpers shared by the peer channel (node:http) and the browser
 * channel (Fetch API). No framework: both carriers stay in the plugin.
 * @module dsh-ferry/lib/http
 */
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';

/** An HTTP failure with a status code and a stable code. */
export class HttpError extends Error {
  /**
   * @param {number} status - response status.
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable message.
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Read one request body as JSON.
 * @param {AsyncIterable<Uint8Array>} source - request body.
 * @param {number} [limit] - maximum bytes.
 * @returns {Promise<unknown>} parsed JSON (an empty body reads as `{}`).
 */
export async function readJson(source, limit = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, 'body-too-large', `JSON body exceeds ${limit} bytes`);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad-json', 'Request body is not valid JSON');
  }
}

/**
 * Write one JSON response with no-store caching.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - status code.
 * @param {unknown} value - JSON value.
 */
export function sendJson(res, status, value) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Write one error response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} error - thrown value.
 */
export function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal';
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, { ok: false, error: { code, message } });
}

/**
 * Write one streaming response with backpressure.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {AsyncIterable<Uint8Array>} body - response bytes.
 * @param {Record<string, string>} headers - extra headers.
 * @param {() => void} [onClose] - called when the peer disconnects before completion.
 */
export async function sendStream(res, body, headers = {}, onClose) {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    ...headers,
  });
  try {
    for await (const chunk of body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) {
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
    }
    res.end();
  } catch (error) {
    if (!res.destroyed) res.destroy(error instanceof Error ? error : new Error(String(error)));
    onClose?.();
    throw error;
  }
}

/**
 * Decode a request body when the sender marked it gzip.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {AsyncIterable<Uint8Array>} decoded bytes.
 */
export function requestBody(req) {
  const encoding = req.headers['x-ferry-encoding'];
  if (encoding !== 'gzip') return req;
  const gunzip = createGunzip();
  req.pipe(gunzip);
  // Surface transport failures on the decoding stream instead of unhandled
  // 'error' events on the request.
  req.on('error', (error) => gunzip.destroy(error));
  return gunzip;
}

/**
 * Read one browser Fetch request body as JSON.
 * @param {Request} request - incoming request.
 * @param {number} [limit] - maximum bytes.
 * @returns {Promise<unknown>} parsed JSON.
 */
export async function readFetchJson(request, limit = 1024 * 1024) {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > limit) {
    throw new HttpError(413, 'body-too-large', `JSON body exceeds ${limit} bytes`);
  }
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'body-too-large', `JSON body exceeds ${limit} bytes`);
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad-json', 'Request body is not valid JSON');
  }
}

/**
 * Build a Fetch JSON response.
 * @param {number} status - status code.
 * @param {unknown} value - JSON value.
 * @returns {Response} response.
 */
export function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Convert a node Readable (including a gzip decoder) to a web ReadableStream.
 * @param {import('node:stream').Readable} readable - node stream.
 * @returns {ReadableStream<Uint8Array>} web stream.
 */
export function toWebStream(readable) {
  return Readable.toWeb(readable);
}
