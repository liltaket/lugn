/** How long a stopped runtime gets to end on its own. */
const exitGraceMs = 5_000;

/**
 * Ends a process that is still running after the runtime has stopped and saved
 * its state. A WebSocket whose peer never answers the close (Node cannot
 * terminate it), or a handle that was missed, would otherwise keep the process
 * until the service manager kills it, with room control down meanwhile. The
 * warning names what was left, so it can be fixed.
 */
export function exitWhenLingering(
  graceMs = exitGraceMs,
  host: Pick<
    NodeJS.Process,
    'exit' | 'getActiveResourcesInfo'
  > = globalThis.process,
): void {
  setTimeout(() => {
    console.warn(
      `[lugn] still running ${graceMs / 1000} s after stopping (${host.getActiveResourcesInfo().join(', ')}); exiting`,
    );
    host.exit();
  }, graceMs).unref();
}
