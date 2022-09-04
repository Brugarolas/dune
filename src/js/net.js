// TCP Networking APIs
//
// The TCP Networking APIs provide an asynchronous network API for creating
// stream-based TCP servers and clients.
//
// https://nodejs.org/dist/latest-v18.x/docs/api/net.html

import dns from 'dns';
import assert from 'assert';
import { EventEmitter } from 'events';

const binding = process.binding('net');

function parseConnectArgs(args) {
  // Connect called using options overloading.
  if (typeof args[0] === 'object') {
    return [args[0]?.port, args[0]?.host, args[1]];
  }
  return args;
}

function toUint8Array(data, encoding) {
  if (!(data instanceof Uint8Array)) {
    return new TextEncoder(encoding).encode(data);
  }
  return data;
}

function makeDeferredPromise() {
  // Extract the resolve method from the promise.
  const promiseExt = {};
  const promise = new Promise((r) => (promiseExt.resolve = r));
  // Attach it to the promise.
  promise.resolve = promiseExt.resolve;
  return promise;
}

/**
 * A Socket object is a wrapper for a raw TCP socket.
 */
export class Socket extends EventEmitter {
  #id;
  #connecting;
  #encoding;

  /**
   * Creates a new Socket instance.
   *
   * @returns {Socket}
   */
  constructor() {
    super();
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this.remotePort = undefined;
    this.remoteAddress = undefined;
  }

  /**
   * Initiates a connection on a given remote host.
   *
   * @param  {...any} args
   * @returns {Promise<Undefined>}
   */
  async connect(...args) {
    // Parse arguments.
    const [port, hostUnchecked, onConnection] = parseConnectArgs(args);
    const hostname = hostUnchecked || '127.0.0.1';

    // Check the port parameter type.
    if (Number.isNaN(Number.parseInt(port))) {
      throw new TypeError(`The "port" option must be castable to number.`);
    }

    // Check the host parameter type.
    if (hostname && typeof hostname !== 'string') {
      throw new TypeError(`The "host" option must be of type string.`);
    }

    // Check if socket is already connected.
    if (this.#id) {
      throw new Error(
        `Socket is already connected to <${this.remoteAddress}:${this.remotePort}>.`
      );
    }

    // Check if a connection is happening.
    if (this.#connecting) {
      this._throw(new Error('Socket is trying to connect.'));
    }

    // Subscribe to the emitter, the on-connect callback if specified.
    if (onConnection) {
      assert.isFunction(onConnection);
      this.on('connect', onConnection);
    }

    try {
      // Use DNS lookup to resolve the hostname.
      const addresses = await dns.lookup(hostname);

      // Prefer IPv4 address.
      const host = addresses.some((addr) => addr.family === 'IPv4')
        ? addresses.filter((addr) => addr.family === 'IPv4')[0].address
        : addresses[0].address;

      // Try to connect to the remote host.
      const socketInfo = await binding.connect(host, port);

      this.#id = socketInfo.id;
      this.#connecting = false;
      this.remoteAddress = socketInfo.remoteAddress;
      this.remotePort = socketInfo.remotePort;

      this.emit('connect', socketInfo);
      binding.readStart(this.#id, this._onSocketRead.bind(this));
      return socketInfo;
    } catch (e) {
      this._throw(e);
    }
  }

  _throw(err) {
    // Use event-emitter to throw connection errors (if registered).
    if (this.listenerCount('error') > 0) {
      return this.emit('error', err);
    }
    throw err;
  }

  _onSocketRead(err, arrayBufferView) {
    // Check for read errors.
    if (err) {
      this._throw(err);
    }

    // Check if the remote host closed the connection.
    if (arrayBufferView.byteLength === 0) {
      this.destroy();
      return this.emit('end');
    }

    this.bytesRead += arrayBufferView.byteLength;

    // Transform ArrayBuffer into a Uint8Array we can use.
    const data = new Uint8Array(arrayBufferView);
    const data_transform = this.#encoding
      ? new TextDecoder(this.#encoding).decode(new Uint8Array(data))
      : data;

    this.emit('data', data_transform);
  }

  /**
   * Sets the encoding for the current socket.
   *
   * @param {String} [encoding]
   */
  setEncoding(encoding = 'utf-8') {
    // Check the parameter type.
    if (typeof encoding !== 'string') {
      throw new TypeError('The "encoding" argument must be of type string.');
    }
    this.#encoding = encoding;
  }

  /**
   * Writes contents to a TCP socket stream.
   *
   * @param {String|Uint8Array} data
   * @param {String} [encoding]
   * @param {Function} [onWrite]
   * @returns {Promise<Number>}
   */
  async write(data, encoding, onWrite) {
    // Check the data argument type.
    if (!(data instanceof Uint8Array) && typeof data !== 'string') {
      throw new TypeError(
        `The "data" argument must be of type string or Uint8Array.`
      );
    }

    // Check the type of the onWrite param.
    if (onWrite) {
      assert.isFunction(onWrite);
    }

    // Check if the socket is connected.
    if (!this.#id) {
      throw new Error(`Socket is not connected to a remote host.`);
    }

    // Default tu UTF-8 encodning.
    encoding = encoding || this.#encoding || 'utf-8';

    const bytes = toUint8Array(data, encoding);
    const bytesWritten = await binding.write(this.#id, bytes);

    this.bytesWritten += bytesWritten;

    if (onWrite) onWrite(bytesWritten);

    return bytesWritten;
  }

  /**
   * Closes both sides of the TCP sockets.
   */
  async destroy() {
    // Check if the socket is indeed connected.
    if (!this.#id) {
      throw new Error('Socket is not connected to a remote host.');
    }
    // Close the socket.
    await binding.close(this.#id);
    this.emit('close');
    this._reset();
  }

  /**
   * Resets socket's internal state (not to be called manually).
   */
  _reset() {
    this.#id = undefined;
    this.#connecting = false;
    this.#encoding = undefined;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this.remotePort = undefined;
    this.remoteAddress = undefined;
  }

  /**
   * Socket should be an async iterator.
   */
  async *[Symbol.asyncIterator]() {
    const queue = [makeDeferredPromise()];
    let done = false;
    let idx = 0;

    this.on('data', (data) => {
      queue[idx].resolve(data);
      const promise = makeDeferredPromise();
      idx++;
      queue.push(promise);
    });

    this.on('error', (e) => {
      throw e;
    });

    this.on('end', () => (done = true));

    while (!done) {
      const data = await queue[0];
      queue.shift();
      idx--;
      yield data;
    }
  }
}

/**
 * Initiates a connection to a given remote host.
 *
 * @param {Object} options
 * @param {Function} [onConnection]
 */
export function createConnection(...args) {
  const socket = new Socket();
  socket.connect(...args);
  return socket;
}

export default {
  Socket,
  createConnection,
};