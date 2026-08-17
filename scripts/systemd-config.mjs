// Pure systemd unit/environment parsing helpers used by setup.mjs.
//
// Keep the two grammars deliberately separate:
//   * Environment=/UnsetEnvironment= are whitespace-separated systemd words
//     with systemd C escapes.
//   * EnvironmentFile= takes one complete path argument. systemd's
//     config_parse_unit_env_file receives that complete RHS, so spaces and
//     backslashes are path characters; it is not an Environment word list.

export const VALID_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function trimSystemdWhitespace(value) {
  return String(value).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

function isUnicodeNoncharacter(codepoint) {
  return (codepoint >= 0xFDD0 && codepoint <= 0xFDEF)
    || (codepoint & 0xFFFF) >= 0xFFFE;
}

function assertUnicodeScalar(codepoint, context) {
  if (codepoint === 0 || codepoint > 0x10FFFF
      || (codepoint >= 0xD800 && codepoint <= 0xDFFF)
      || codepoint === 0xFEFF
      || isUnicodeNoncharacter(codepoint)) {
    throw new Error(`invalid Unicode scalar in ${context}`);
  }
}

export function validateUnicodeScalars(value, context) {
  for (let index = 0; index < value.length; index += 1) {
    const codepoint = value.codePointAt(index);
    assertUnicodeScalar(codepoint, context);
    if (codepoint > 0xFFFF) index += 1;
  }
}

/** Parse a systemd word list while retaining escapes for one semantic decode. */
export function splitSystemdWords(value) {
  const words = [];
  const isWhitespace = char => char === ' ' || char === '\t' || char === '\r' || char === '\n';
  let word = '';
  let quote = null;
  let escaping = false;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaping) {
      // Keep the marker for unescapeSystemdString(). Consuming it here would
      // decode some values twice when the parser is used for a round-trip.
      word += `\\${char}`;
      escaping = false;
      started = true;
    } else if (char === '\\') {
      escaping = true;
      started = true;
    } else if (quote) {
      if (char === quote) {
        const next = value[index + 1];
        if (next !== undefined && !isWhitespace(next)) {
          throw new Error(`closing systemd ${quote} quote must be followed by whitespace`);
        }
        quote = null;
      } else word += char;
      started = true;
    } else if (char === '"' || char === "'") {
      if (started) throw new Error(`systemd ${char} quote must start a word`);
      quote = char;
      started = true;
    } else if (isWhitespace(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (escaping) throw new Error(`unterminated systemd escape at position ${value.length - 1}`);
  if (quote) throw new Error(`unterminated systemd ${quote} quote`);
  if (started) words.push(word);
  return words;
}

/** Decode one systemd C-escaped Environment=/UnsetEnvironment= word. */
export function unescapeSystemdString(value) {
  const bytes = [];
  const encoder = new TextEncoder();
  const appendText = text => {
    validateUnicodeScalars(text, 'systemd unit escape');
    bytes.push(...encoder.encode(text));
  };
  let index = 0;
  while (index < value.length) {
    if (value[index] === '\\' && index + 1 < value.length) {
      const next = value[index + 1];
      switch (next) {
        case '\\': appendText('\\'); index += 2; break;
        case '"': appendText('"'); index += 2; break;
        case "'": appendText("'"); index += 2; break;
        case 'n': appendText('\n'); index += 2; break;
        case 'r': appendText('\r'); index += 2; break;
        case 't': appendText('\t'); index += 2; break;
        case 's': appendText(' '); index += 2; break;
        case 'a': appendText('\x07'); index += 2; break;
        case 'b': appendText('\b'); index += 2; break;
        case 'f': appendText('\f'); index += 2; break;
        case 'v': appendText('\v'); index += 2; break;
        case 'x': {
          const hex = value.slice(index + 2, index + 4);
          if (hex.length === 2 && /^[0-9a-f]{2}$/i.test(hex)) {
            const byte = Number.parseInt(hex, 16);
            if (byte === 0) throw new Error(`invalid NUL escape at position ${index}`);
            bytes.push(byte);
            index += 4;
            break;
          }
          throw new Error(`invalid escape sequence \\x at position ${index}; expected \\xHH`);
        }
        case 'u': {
          const hex = value.slice(index + 2, index + 6);
          if (hex.length === 4 && /^[0-9a-f]{4}$/i.test(hex)) {
            const codepoint = Number.parseInt(hex, 16);
            if (codepoint > 0 && codepoint <= 0x10FFFF) {
              assertUnicodeScalar(codepoint, 'systemd unit escape');
              appendText(String.fromCodePoint(codepoint));
              index += 6;
              break;
            }
          }
          throw new Error(`invalid escape sequence \\u at position ${index}; expected \\uHHHH`);
        }
        case 'U': {
          const hex = value.slice(index + 2, index + 10);
          if (hex.length === 8 && /^[0-9a-f]{8}$/i.test(hex)) {
            const codepoint = Number.parseInt(hex, 16);
            if (codepoint > 0 && codepoint <= 0x10FFFF) {
              assertUnicodeScalar(codepoint, 'systemd unit escape');
              appendText(String.fromCodePoint(codepoint));
              index += 10;
              break;
            }
          }
          throw new Error(`invalid escape sequence \\U at position ${index}; expected \\UHHHHHHHH`);
        }
        default: {
          // Unit-file octal escapes are exactly three digits. A path in an
          // EnvironmentFile= directive does not come through this function.
          if (/^[0-7]$/.test(next)) {
            const octal = value.slice(index + 1, index + 4);
            if (!/^[0-7]{3}$/.test(octal)) {
              throw new Error(`invalid octal escape at position ${index}; expected exactly three digits`);
            }
            const code = Number.parseInt(octal, 8);
            if (code === 0) throw new Error(`invalid NUL escape at position ${index}`);
            if (code > 0xFF) throw new Error(`invalid octal escape at position ${index}; expected a byte`);
            bytes.push(code);
            index += 4;
            break;
          }
          throw new Error(`unsupported escape sequence \\${next} at position ${index}`);
        }
      }
    } else {
      const codepoint = value.codePointAt(index);
      const text = String.fromCodePoint(codepoint);
      appendText(text);
      index += text.length;
    }
  }
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    throw new Error('invalid UTF-8 byte-order mark in systemd unit escape');
  }
  let result;
  try {
    result = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new Error('invalid UTF-8 byte sequence in systemd unit escape');
  }
  validateUnicodeScalars(result, 'systemd unit escape');
  return result;
}

export function decodeSystemdEnvironmentFile(content, source) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    throw new Error('EnvironmentFile contains a UTF-8 byte-order mark');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`EnvironmentFile is not valid UTF-8${source ? ` (${source})` : ''}`);
  }
}

export function expandSupportedSystemdSpecifiers(value, { home, uid } = {}) {
  const expandedHome = home ?? process.env.HOME ?? '';
  const expandedUid = uid == null && typeof process.getuid === 'function' ? String(process.getuid()) : uid == null ? null : String(uid);
  let expanded = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '%') {
      expanded += char;
      continue;
    }
    const specifier = value[index + 1];
    if (specifier === '%') expanded += '%';
    else if (specifier === 'h') expanded += expandedHome;
    else if (specifier === 'U' && expandedUid !== null) expanded += expandedUid;
    else {
      const token = specifier === undefined ? '%' : `%${specifier}`;
      throw new Error(`unsupported or incomplete systemd specifier ${JSON.stringify(token)}; setup supports only %%, %h and %U`);
    }
    index += 1;
  }
  return expanded;
}

export function joinSystemdUnitLines(content) {
  const logicalLines = [];
  let pending = '';
  let continued = false;
  for (const physical of String(content).split(/\r?\n/)) {
    if (continued && /^[ \t]*[#;]/.test(physical)) continue;
    let trailingBackslashes = 0;
    for (let index = physical.length - 1; index >= 0 && physical[index] === '\\'; index -= 1) trailingBackslashes += 1;
    if (trailingBackslashes % 2 === 1) {
      pending += `${physical.slice(0, -1)} `;
      continued = true;
      continue;
    }
    logicalLines.push(pending + physical);
    pending = '';
    continued = false;
  }
  if (pending) throw new Error('unterminated systemd line continuation');
  return logicalLines;
}

/**
 * Parse only service environment directives. Section names are exact: unlike
 * many INI parsers, [service] is not [Service] in systemd.
 */
export function parseSystemdEnvironment(content) {
  const env = {};
  const environmentFiles = [];
  const events = [];
  const suspiciousSections = [];
  let section = null;
  for (const rawLine of joinSystemdUnitLines(content)) {
    const line = rawLine.replace(/^[ \t\r]+|[ \t\r]+$/g, '');
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      if (section.trim().toLowerCase() === 'service' && section !== 'Service') suspiciousSections.push(section);
      continue;
    }
    if (section !== 'Service') continue;
    const assignment = line.match(/^([A-Za-z][A-Za-z0-9]*)[ \t\r]*=[ \t\r]*(.*)$/);
    if (!assignment) continue;
    const directive = assignment[1];
    const value = trimSystemdWhitespace(assignment[2]);
    if (directive === 'EnvironmentFile') {
      if (!value) {
        environmentFiles.length = 0;
        events.push({ type: 'environment-file-reset' });
      } else {
        // EnvironmentFile= is a single complete path RHS. Do not split it
        // into Environment= words or C-unescape its backslashes here.
        environmentFiles.push(value);
        events.push({ type: 'environment-file', value });
      }
      continue;
    }
    if (directive === 'UnsetEnvironment') {
      if (!value) {
        events.push({ type: 'unset-environment-reset' });
        continue;
      }
      const entries = splitSystemdWords(value).map((entry) => {
        const unescapedEntry = unescapeSystemdString(entry);
        const expandedEntry = expandSupportedSystemdSpecifiers(unescapedEntry);
        const separator = expandedEntry.indexOf('=');
        const key = separator < 0 ? expandedEntry : expandedEntry.slice(0, separator);
        if (!VALID_ENV_KEY.test(key)) throw new Error(`invalid systemd UnsetEnvironment entry for ${JSON.stringify(key)}`);
        if (separator < 0) return key;
        return expandedEntry;
      });
      events.push({ type: 'unset-environment', entries });
      continue;
    }
    if (directive !== 'Environment') continue;
    if (!value) {
      for (const key of Object.keys(env)) delete env[key];
      events.push({ type: 'environment-reset' });
      continue;
    }
    const assignments = [];
    for (const word of splitSystemdWords(value)) {
      const unescapedAssignment = unescapeSystemdString(word);
      const expandedAssignment = expandSupportedSystemdSpecifiers(unescapedAssignment);
      const separator = expandedAssignment.indexOf('=');
      if (separator <= 0) throw new Error('invalid systemd Environment assignment');
      const key = expandedAssignment.slice(0, separator);
      if (!VALID_ENV_KEY.test(key)) throw new Error(`invalid systemd Environment key ${JSON.stringify(key)}`);
      const entry = { key, value: expandedAssignment.slice(separator + 1) };
      env[key] = entry.value;
      assignments.push(entry);
    }
    if (assignments.length > 0) events.push({ type: 'environment', assignments });
  }
  return { env, environmentFiles, events, suspiciousSections };
}

export function applySystemdEvents(initialEnv, initialEnvironmentFiles, events, initialUnsetEnvironment = []) {
  let env = { ...initialEnv };
  let environmentFiles = [...initialEnvironmentFiles];
  let unsetEnvironment = [...initialUnsetEnvironment];
  for (const event of events) {
    if (event.type === 'environment-reset') env = {};
    if (event.type === 'environment') for (const assignment of event.assignments) env[assignment.key] = assignment.value;
    if (event.type === 'environment-file-reset') environmentFiles = [];
    if (event.type === 'environment-file') environmentFiles.push(event.value);
    if (event.type === 'unset-environment-reset') unsetEnvironment = [];
    if (event.type === 'unset-environment') unsetEnvironment.push(...event.entries);
  }
  return { env, environmentFiles, unsetEnvironment };
}

export function applySystemdUnsetEnvironment(environment, entries) {
  const env = { ...environment };
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator < 0) {
      delete env[entry];
      continue;
    }
    const key = entry.slice(0, separator);
    const expectedValue = entry.slice(separator + 1);
    if (env[key] === expectedValue) delete env[key];
  }
  return env;
}

/** Parse systemd.exec EnvironmentFile contents (not the directive path). */
export function parseSystemdEnvironmentFile(content) {
  validateUnicodeScalars(content, 'EnvironmentFile');
  const env = {};
  let key = '';
  let value = '';
  let keyTrailingWhitespace = -1;
  let valueTrailingWhitespace = -1;
  let state = 'pre-key';
  let hasAssignment = false;
  let line = 1;
  const reset = () => {
    key = '';
    value = '';
    keyTrailingWhitespace = -1;
    valueTrailingWhitespace = -1;
    hasAssignment = false;
  };
  const finish = (final = false) => {
    if (!hasAssignment) {
      reset();
      state = 'pre-key';
      return;
    }
    const finalKey = keyTrailingWhitespace >= 0 ? key.slice(0, keyTrailingWhitespace) : key;
    const finalValue = state === 'value' && valueTrailingWhitespace >= 0
      ? value.slice(0, valueTrailingWhitespace)
      : value;
    if (!VALID_ENV_KEY.test(finalKey)) throw new Error(`invalid EnvironmentFile key on line ${line}`);
    validateUnicodeScalars(finalKey, 'EnvironmentFile key');
    validateUnicodeScalars(finalValue, 'EnvironmentFile value');
    env[finalKey] = finalValue;
    reset();
    state = 'pre-key';
    if (!final) line += 1;
  };
  const isWhitespace = char => char === ' ' || char === '\t' || char === '\r';
  const isNewline = char => char === '\n';
  const doubleQuoteEscapes = new Set(['"', '\\', '$', '`']);

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    switch (state) {
      case 'pre-key':
        if (isNewline(char)) line += 1;
        else if (isWhitespace(char)) {
          // Leading whitespace is ignored.
        } else if (char === '#' || char === ';') state = 'comment';
        else {
          state = 'key';
          key += char;
        }
        break;
      case 'key':
        if (isNewline(char)) {
          reset();
          state = 'pre-key';
          line += 1;
        } else if (char === '=') {
          hasAssignment = true;
          state = 'pre-value';
        } else {
          key += char;
          if (isWhitespace(char)) {
            if (keyTrailingWhitespace < 0) keyTrailingWhitespace = key.length - 1;
          } else keyTrailingWhitespace = -1;
        }
        break;
      case 'pre-value':
        if (isNewline(char)) finish();
        else if (char === "'") state = 'single-quote';
        else if (char === '"') state = 'double-quote';
        else if (char === '\\') state = 'value-escape';
        else if (!isWhitespace(char)) {
          value += char;
          state = 'value';
        }
        break;
      case 'value':
        if (isNewline(char)) finish();
        else if (char === '\\') {
          valueTrailingWhitespace = -1;
          state = 'value-escape';
        } else {
          value += char;
          if (isWhitespace(char)) {
            if (valueTrailingWhitespace < 0) valueTrailingWhitespace = value.length - 1;
          } else valueTrailingWhitespace = -1;
        }
        break;
      case 'value-escape':
        if (isNewline(char)) {
          state = 'value';
          line += 1;
        } else {
          value += char;
          valueTrailingWhitespace = -1;
          state = 'value';
        }
        break;
      case 'single-quote':
        if (char === "'") state = 'pre-value';
        else value += char;
        break;
      case 'double-quote':
        if (char === '"') state = 'pre-value';
        else if (char === '\\') state = 'double-quote-escape';
        else value += char;
        break;
      case 'double-quote-escape':
        if (isNewline(char)) {
          state = 'double-quote';
          line += 1;
        } else if (doubleQuoteEscapes.has(char)) {
          value += char;
          state = 'double-quote';
        } else {
          value += `\\${char}`;
          state = 'double-quote';
        }
        break;
      case 'comment':
        if (char === '\\') state = 'comment-escape';
        else if (isNewline(char)) {
          state = 'pre-key';
          line += 1;
        }
        break;
      case 'comment-escape':
        if (isNewline(char)) {
          state = 'pre-key';
          line += 1;
        } else state = 'comment';
        break;
      default:
        throw new Error(`invalid EnvironmentFile parser state on line ${line}`);
    }
  }
  if (state === 'single-quote' || state === 'double-quote' || state === 'double-quote-escape') {
    throw new Error(`unterminated EnvironmentFile quote on line ${line}`);
  }
  if (state === 'value-escape') {
    throw new Error(`unterminated EnvironmentFile continuation on line ${line}`);
  }
  if (state !== 'pre-key' && state !== 'key' && state !== 'comment' && state !== 'comment-escape') finish(true);
  return env;
}

/**
 * EnvironmentFile= is intentionally not parsed with splitSystemdWords().
 * systemd's config_parse_unit_env_file receives one complete RHS and only
 * expands unit specifiers; quotes and backslashes are path bytes.
 */
export function parseSystemdEnvironmentFilePath(value, expandSpecifiers) {
  const raw = trimSystemdWhitespace(value);
  if (!raw) return { reset: true };
  const expanded = expandSpecifiers(raw);
  const optional = expanded.startsWith('-');
  const path = optional ? expanded.slice(1) : expanded;
  return {
    raw,
    optional,
    path,
    absolute: path.startsWith('/'),
  };
}

export function escapeSystemdUnitString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

export function quoteSystemdEnvironment(key, value) {
  return `Environment="${escapeSystemdUnitString(`${key}=${String(value)}`)}"`;
}

export function quoteSystemdUnsetEnvironmentEntry(entry) {
  const escaped = escapeSystemdUnitString(entry);
  return entry.includes('=') || /[ \t\r\n]/.test(entry) ? `"${escaped}"` : escaped;
}

export function formatSystemdUnsetEnvironment(entries) {
  return entries.length > 0
    ? `UnsetEnvironment=${entries.map(quoteSystemdUnsetEnvironmentEntry).join(' ')}`
    : '';
}

/** All values, including overridden values, are useful for diagnostics redaction. */
export function collectSystemdEnvironmentValues(parsed) {
  const values = [];
  for (const event of parsed?.events || []) {
    if (event.type === 'environment') {
      for (const assignment of event.assignments) values.push(assignment.value);
    }
    if (event.type === 'unset-environment') {
      for (const entry of event.entries) {
        const separator = entry.indexOf('=');
        if (separator >= 0) values.push(entry.slice(separator + 1));
      }
    }
  }
  return values;
}
