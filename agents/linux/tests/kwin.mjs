// Exercise the actual bundled script with a tiny KWin signal harness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
function signal() {
  const listeners = new Set();
  return {
    connect(fn) {
      listeners.add(fn);
    },
    disconnect(fn) {
      listeners.delete(fn);
    },
    emit() {
      for (const fn of [...listeners]) fn();
    },
    get size() {
      return listeners.size;
    },
  };
}
for (const modern of [true, false]) {
  const activation = signal();
  const window = {
    desktopFileName: 'org.kde.konsole',
    resourceClass: 'konsole',
    fullScreen: false,
    fullScreenChanged: signal(),
    desktopFileNameChanged: signal(),
    windowClassChanged: signal(),
  };
  const workspace = modern
    ? { activeWindow: window, windowActivated: activation }
    : { activeClient: window, clientActivated: activation };
  const reports = [];
  vm.runInNewContext(
    fs.readFileSync(
      path.join(import.meta.dirname, '../kwin/observe.js'),
      'utf8',
    ),
    { workspace, callDBus: (...args) => reports.push(args.slice(4)) },
  );
  assert.deepEqual(reports.at(-1), [true, 'org.kde.konsole', 'konsole', false]);
  for (let i = 0; i < 100; i++) activation.emit();
  assert.equal(window.fullScreenChanged.size, 1);
  window.fullScreen = true;
  window.fullScreenChanged.emit();
  assert.equal(reports.at(-1)[3], true);
  window.desktopFileName = 'example';
  window.desktopFileNameChanged.emit();
  assert.equal(reports.at(-1)[1], 'example');
  if (modern) workspace.activeWindow = null;
  else workspace.activeClient = null;
  activation.emit();
  assert.deepEqual(reports.at(-1), [false, '', '', false]);
  assert.equal(window.fullScreenChanged.size, 0);
  const count = reports.length;
  window.fullScreenChanged.emit();
  assert.equal(reports.length, count);
}
console.log('KWin bridge fixtures passed (Plasma 5 and 6 names)');
