import { lightingFeedbackMatches } from '../core/lighting-feedback.js';

// The predicate uses only its arguments and standard globals. Prefix classic
// browser scripts with the same executable rule instead of duplicating it.
export const lightingFeedbackBrowserScript = `const lightingFeedbackMatches = ${lightingFeedbackMatches.toString()};\n`;
