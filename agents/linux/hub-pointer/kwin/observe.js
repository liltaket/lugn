// lugn-hub-pointer observer. Read-only: no shortcuts, timers, window changes
// or input handling. It reports the active window (for the game gate) and
// whether the cursor is near the Hub's entry corner (for warm-up), the latter
// only when that changes. The agent fills in the placeholders at load time.
(function () {
  var SERVICE = '@SERVICE@';
  var PATH = '/org/lugn/HubPointer';
  var IFACE = 'org.lugn.HubPointer';
  var APPROACH_MAX_X = Number('@APPROACH_MAX_X@');
  var APPROACH_MIN_Y = Number('@APPROACH_MIN_Y@');

  var active = null;
  function report() {
    var w = workspace.activeWindow;
    callDBus(
      SERVICE,
      PATH,
      IFACE,
      'ObserveWindow',
      !!w,
      w ? String(w.desktopFileName || '') : '',
      w ? String(w.resourceClass || '') : '',
      w ? !!w.fullScreen : false,
    );
  }
  function unwatch(w, name) {
    try {
      if (w[name]) w[name].disconnect(report);
    } catch (error) {
      void error;
    }
  }
  function watch(w, name) {
    if (w[name]) w[name].connect(report);
  }
  var signals = [
    'fullScreenChanged',
    'desktopFileNameChanged',
    'windowClassChanged',
  ];
  function observe() {
    var i;
    if (active)
      for (i = 0; i < signals.length; i++) unwatch(active, signals[i]);
    active = workspace.activeWindow;
    if (active) for (i = 0; i < signals.length; i++) watch(active, signals[i]);
    report();
  }
  workspace.windowActivated.connect(observe);
  observe();

  // Runs on every pointer move, so it only compares two numbers and calls
  // the agent on transitions.
  var inside = null;
  function cursorMoved() {
    var p = workspace.cursorPos;
    var now = p.x <= APPROACH_MAX_X && p.y >= APPROACH_MIN_Y;
    if (now === inside) return;
    inside = now;
    callDBus(SERVICE, PATH, IFACE, 'ObserveApproach', now);
  }
  if (
    workspace.cursorPosChanged &&
    typeof workspace.cursorPos !== 'undefined'
  ) {
    workspace.cursorPosChanged.connect(cursorMoved);
    cursorMoved();
  }
})();
