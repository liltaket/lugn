import { RuntimeConfigError, loadRuntimeConfig } from './config.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error('[lugn] Usage: npm run config:check -- [config-path]');
    process.exitCode = 2;
    return;
  }

  try {
    const config = loadRuntimeConfig(args[0]);
    console.info(
      [
        '[lugn] Configuration valid.',
        `Lights: ${Object.keys(config.homeAssistant.entities).length}`,
        `Buttons: ${Object.keys(config.homeAssistant.buttons).length}`,
        `Switches: ${Object.keys(config.homeAssistant.switches).length}`,
        `Media targets: ${Object.keys(config.homeAssistant.music).length}`,
        `MQTT: ${config.mqtt ? 'enabled' : 'disabled'}`,
      ].join(' '),
    );
  } catch (error) {
    console.error(`[lugn] ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof RuntimeConfigError)) {
    return 'Configuration check failed unexpectedly.';
  }

  if (error.message.startsWith('Could not read valid JSON configuration')) {
    return 'Could not read valid JSON configuration file.';
  }
  if (error.message.startsWith('Invalid configuration:')) {
    return 'Configuration schema validation failed. Check the config file.';
  }

  const missingEnvironmentVariable =
    /^Required environment variable is missing: ([A-Z_][A-Z0-9_]*)$/.exec(
      error.message,
    );
  if (missingEnvironmentVariable) {
    return `Required environment variable is missing: ${missingEnvironmentVariable[1]}.`;
  }
  if (error.message.startsWith('Lugn binds only to loopback.')) {
    return 'Lugn HTTP host must be a loopback address.';
  }

  return 'Configuration check failed. Verify the file and required environment variables.';
}

void main();
