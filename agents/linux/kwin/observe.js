// Read-only KWin bridge: no shortcuts, timers, window mutations or input capture.
// Plasma 6 names with Plasma 5 compatibility for Kubuntu 22.04/24.04.
(function () {
  var modern = typeof workspace.activeWindow !== 'undefined';
  var active = null;
  function report() {
    var w = modern ? workspace.activeWindow : workspace.activeClient;
    callDBus(
      'org.lugn.LinuxAgent',
      '/org/lugn/LinuxAgent',
      'org.lugn.LinuxAgent',
      'ObserveWindow',
      !!w,
      w ? String(w.desktopFileName || '') : '',
      w ? String(w.resourceClass || '') : '',
      w ? !!w.fullScreen : false,
    );
  }
  function observe() {
    if (active) {
      try {
        active.fullScreenChanged.disconnect(report);
      } catch (error) {
        void error;
      }
      try {
        active.desktopFileNameChanged.disconnect(report);
      } catch (error) {
        void error;
      }
      try {
        active.windowClassChanged.disconnect(report);
      } catch (error) {
        void error;
      }
    }
    active = modern ? workspace.activeWindow : workspace.activeClient;
    if (active) {
      active.fullScreenChanged.connect(report);
      if (active.desktopFileNameChanged)
        active.desktopFileNameChanged.connect(report);
      if (active.windowClassChanged) active.windowClassChanged.connect(report);
    }
    report();
  }
  if (modern) workspace.windowActivated.connect(observe);
  else workspace.clientActivated.connect(observe);
  observe();
})();
