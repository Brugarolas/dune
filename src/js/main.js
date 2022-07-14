import { Console } from 'console';
import { TextEncoder, TextDecoder } from 'text-encoding';
import { setTimeout, setInterval, clearTimeout, clearInterval } from 'timers';
import { cloneFunction } from 'util';

globalThis.global = globalThis;

global.GLOBAL = globalThis;
global.root = globalThis;

/**
 * Registers a value to global scope.
 *
 * @param {String} name
 * @param {*} value
 */
function makeGlobal(name, value) {
  globalThis[name] = value;
}

// Adding a caching layer to `process.binding` so we don't
// cross the JavaScript to Rust bridge every time we need native methods.

let cache = new Map();
let internalBinding = cloneFunction(process.binding);

process.binding = function (name) {
  // Check bindings cache.
  if (cache.has(name)) return cache.get(name);

  // Load binding (from rust), save it to cache.
  const binding = internalBinding(name);
  cache.set(name, binding);

  return binding;
};

// Setting up the STDOUT stream.

let stdout = process.stdout;

Object.defineProperty(process, 'stdout', {
  get() {
    // Don't initialize twice.
    if (stdout) return stdout;

    // Setup stdout stream.
    const binding = process.binding('stdio');

    return {
      write(value) {
        binding.write(value);
      }
    };
  },
  configurable: true
});

// Setting up the STDERR stream.

let stderr = process.stderr;

Object.defineProperty(process, 'stderr', {
  get() {
    // Don't initialize twice.
    if (stderr) return stderr;

    // Setup stderr stream.
    const binding = process.binding('stdio');

    return {
      write(value) {
        binding.writeError(value);
      }
    };
  },
  configurable: true
});

// Console.
makeGlobal('console', new Console());

// Timers.
makeGlobal('setTimeout', setTimeout);
makeGlobal('setInterval', setInterval);
makeGlobal('clearTimeout', clearTimeout);
makeGlobal('clearInterval', clearInterval);

// Encoders.
makeGlobal('TextEncoder', TextEncoder);
makeGlobal('TextDecoder', TextDecoder);