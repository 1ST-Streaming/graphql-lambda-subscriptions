'use strict';

var graphql = require('graphql');
var awsSdk = require('aws-sdk');
var execute = require('graphql/execution/execute');
var values = require('graphql/execution/values');
var streamingIterables = require('streaming-iterables');
var debug = require('debug');

/**
 *
 * common
 *
 */
/**
 * The WebSocket sub-protocol used for the [GraphQL over WebSocket Protocol](https://github.com/graphql/graphql-over-http/blob/main/rfcs/GraphQLOverWebSocket.md).
 *
 * @category Common
 */
const GRAPHQL_TRANSPORT_WS_PROTOCOL = 'graphql-transport-ws';
/**
 * `graphql-ws` expected and standard close codes of the [GraphQL over WebSocket Protocol](https://github.com/graphql/graphql-over-http/blob/main/rfcs/GraphQLOverWebSocket.md).
 *
 * @category Common
 */
var CloseCode;
(function (CloseCode) {
    CloseCode[CloseCode["InternalServerError"] = 4500] = "InternalServerError";
    CloseCode[CloseCode["InternalClientError"] = 4005] = "InternalClientError";
    CloseCode[CloseCode["BadRequest"] = 4400] = "BadRequest";
    CloseCode[CloseCode["BadResponse"] = 4004] = "BadResponse";
    /** Tried subscribing before connect ack */
    CloseCode[CloseCode["Unauthorized"] = 4401] = "Unauthorized";
    CloseCode[CloseCode["Forbidden"] = 4403] = "Forbidden";
    CloseCode[CloseCode["SubprotocolNotAcceptable"] = 4406] = "SubprotocolNotAcceptable";
    CloseCode[CloseCode["ConnectionInitialisationTimeout"] = 4408] = "ConnectionInitialisationTimeout";
    CloseCode[CloseCode["ConnectionAcknowledgementTimeout"] = 4504] = "ConnectionAcknowledgementTimeout";
    /** Subscriber distinction is very important */
    CloseCode[CloseCode["SubscriberAlreadyExists"] = 4409] = "SubscriberAlreadyExists";
    CloseCode[CloseCode["TooManyInitialisationRequests"] = 4429] = "TooManyInitialisationRequests";
})(CloseCode || (CloseCode = {}));
/**
 * Types of messages allowed to be sent by the client/server over the WS protocol.
 *
 * @category Common
 */
var MessageType;
(function (MessageType) {
    MessageType["ConnectionInit"] = "connection_init";
    MessageType["ConnectionAck"] = "connection_ack";
    MessageType["Ping"] = "ping";
    MessageType["Pong"] = "pong";
    MessageType["Subscribe"] = "subscribe";
    MessageType["Next"] = "next";
    MessageType["Error"] = "error";
    MessageType["Complete"] = "complete";
})(MessageType || (MessageType = {}));

const postToConnection = (server) => async ({ connectionId: ConnectionId, domainName, stage, message, }) => {
    server.log('sendMessage', { connectionId: ConnectionId, message });
    const api = server.apiGatewayManagementApi ??
        new awsSdk.ApiGatewayManagementApi({
            apiVersion: 'latest',
            endpoint: `${domainName}/${stage}`,
        });
    await api
        .postToConnection({
        ConnectionId,
        Data: JSON.stringify(message),
    })
        .promise();
};

function indentString(string, count = 1, options = {}) {
	const {
		indent = ' ',
		includeEmptyLines = false
	} = options;

	if (typeof string !== 'string') {
		throw new TypeError(
			`Expected \`input\` to be a \`string\`, got \`${typeof string}\``
		);
	}

	if (typeof count !== 'number') {
		throw new TypeError(
			`Expected \`count\` to be a \`number\`, got \`${typeof count}\``
		);
	}

	if (count < 0) {
		throw new RangeError(
			`Expected \`count\` to be at least 0, got \`${count}\``
		);
	}

	if (typeof indent !== 'string') {
		throw new TypeError(
			`Expected \`options.indent\` to be a \`string\`, got \`${typeof indent}\``
		);
	}

	if (count === 0) {
		return string;
	}

	const regex = includeEmptyLines ? /^/gm : /^(?!\s*$)/gm;

	return string.replace(regex, indent.repeat(count));
}

function escapeStringRegexp(string) {
	if (typeof string !== 'string') {
		throw new TypeError('Expected a string');
	}

	// Escape characters with special meaning either inside or outside character sets.
	// Use a simple backslash escape when it’s always valid, and a `\xnn` escape when the simpler form would be disallowed by Unicode patterns’ stricter grammar.
	return string
		.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
		.replace(/-/g, '\\x2d');
}

const getHomeDirectory = () => '';

const extractPathRegex = /\s+at.*[(\s](.*)\)?/;
const pathRegex = /^(?:(?:(?:node|node:[\w/]+|(?:(?:node:)?internal\/[\w/]*|.*node_modules\/(?:babel-polyfill|pirates)\/.*)?\w+)(?:\.js)?:\d+:\d+)|native)/;

function cleanStack(stack, {pretty = false, basePath, pathFilter} = {}) {
	const basePathRegex = basePath && new RegExp(`(file://)?${escapeStringRegexp(basePath.replace(/\\/g, '/'))}/?`, 'g');
	const homeDirectory = pretty ? getHomeDirectory() : '';

	if (typeof stack !== 'string') {
		return undefined;
	}

	return stack.replace(/\\/g, '/')
		.split('\n')
		.filter(line => {
			const pathMatches = line.match(extractPathRegex);
			if (pathMatches === null || !pathMatches[1]) {
				return true;
			}

			const match = pathMatches[1];

			// Electron
			if (
				match.includes('.app/Contents/Resources/electron.asar')
				|| match.includes('.app/Contents/Resources/default_app.asar')
				|| match.includes('node_modules/electron/dist/resources/electron.asar')
				|| match.includes('node_modules/electron/dist/resources/default_app.asar')
			) {
				return false;
			}

			return pathFilter
				? !pathRegex.test(match) && pathFilter(match)
				: !pathRegex.test(match);
		})
		.filter(line => line.trim() !== '')
		.map(line => {
			if (basePathRegex) {
				line = line.replace(basePathRegex, '');
			}

			if (pretty) {
				line = line.replace(extractPathRegex, (m, p1) => m.replace(p1, p1.replace(homeDirectory, '~')));
			}

			return line;
		})
		.join('\n');
}

const cleanInternalStack = stack => stack.replaceAll(/\s+at .*aggregate-error\/index.js:\d+:\d+\)?/g, '');

class AggregateError extends Error {
	#errors;

	name = 'AggregateError';

	constructor(errors) {
		if (!Array.isArray(errors)) {
			throw new TypeError(`Expected input to be an Array, got ${typeof errors}`);
		}

		errors = errors.map(error => {
			if (error instanceof Error) {
				return error;
			}

			if (error !== null && typeof error === 'object') {
				// Handle plain error objects with message property and/or possibly other metadata
				return Object.assign(new Error(error.message), error);
			}

			return new Error(error);
		});

		let message = errors
			.map(error =>
				// The `stack` property is not standardized, so we can't assume it exists
				typeof error.stack === 'string' && error.stack.length > 0 ? cleanInternalStack(cleanStack(error.stack)) : String(error),
			)
			.join('\n');
		message = '\n' + indentString(message, 4);
		super(message);

		this.#errors = errors;
	}

	get errors() {
		return [...this.#errors];
	}
}

/**
 * The set of allowed kind values for AST nodes.
 */
var Kind;

(function (Kind) {
  Kind['NAME'] = 'Name';
  Kind['DOCUMENT'] = 'Document';
  Kind['OPERATION_DEFINITION'] = 'OperationDefinition';
  Kind['VARIABLE_DEFINITION'] = 'VariableDefinition';
  Kind['SELECTION_SET'] = 'SelectionSet';
  Kind['FIELD'] = 'Field';
  Kind['ARGUMENT'] = 'Argument';
  Kind['FRAGMENT_SPREAD'] = 'FragmentSpread';
  Kind['INLINE_FRAGMENT'] = 'InlineFragment';
  Kind['FRAGMENT_DEFINITION'] = 'FragmentDefinition';
  Kind['VARIABLE'] = 'Variable';
  Kind['INT'] = 'IntValue';
  Kind['FLOAT'] = 'FloatValue';
  Kind['STRING'] = 'StringValue';
  Kind['BOOLEAN'] = 'BooleanValue';
  Kind['NULL'] = 'NullValue';
  Kind['ENUM'] = 'EnumValue';
  Kind['LIST'] = 'ListValue';
  Kind['OBJECT'] = 'ObjectValue';
  Kind['OBJECT_FIELD'] = 'ObjectField';
  Kind['DIRECTIVE'] = 'Directive';
  Kind['NAMED_TYPE'] = 'NamedType';
  Kind['LIST_TYPE'] = 'ListType';
  Kind['NON_NULL_TYPE'] = 'NonNullType';
  Kind['SCHEMA_DEFINITION'] = 'SchemaDefinition';
  Kind['OPERATION_TYPE_DEFINITION'] = 'OperationTypeDefinition';
  Kind['SCALAR_TYPE_DEFINITION'] = 'ScalarTypeDefinition';
  Kind['OBJECT_TYPE_DEFINITION'] = 'ObjectTypeDefinition';
  Kind['FIELD_DEFINITION'] = 'FieldDefinition';
  Kind['INPUT_VALUE_DEFINITION'] = 'InputValueDefinition';
  Kind['INTERFACE_TYPE_DEFINITION'] = 'InterfaceTypeDefinition';
  Kind['UNION_TYPE_DEFINITION'] = 'UnionTypeDefinition';
  Kind['ENUM_TYPE_DEFINITION'] = 'EnumTypeDefinition';
  Kind['ENUM_VALUE_DEFINITION'] = 'EnumValueDefinition';
  Kind['INPUT_OBJECT_TYPE_DEFINITION'] = 'InputObjectTypeDefinition';
  Kind['DIRECTIVE_DEFINITION'] = 'DirectiveDefinition';
  Kind['SCHEMA_EXTENSION'] = 'SchemaExtension';
  Kind['SCALAR_TYPE_EXTENSION'] = 'ScalarTypeExtension';
  Kind['OBJECT_TYPE_EXTENSION'] = 'ObjectTypeExtension';
  Kind['INTERFACE_TYPE_EXTENSION'] = 'InterfaceTypeExtension';
  Kind['UNION_TYPE_EXTENSION'] = 'UnionTypeExtension';
  Kind['ENUM_TYPE_EXTENSION'] = 'EnumTypeExtension';
  Kind['INPUT_OBJECT_TYPE_EXTENSION'] = 'InputObjectTypeExtension';
})(Kind || (Kind = {}));
/**
 * The enum type representing the possible kind values of AST nodes.
 *
 * @deprecated Please use `Kind`. Will be remove in v17.
 */

function devAssert(condition, message) {
  const booleanCondition = Boolean(condition);

  if (!booleanCondition) {
    throw new Error(message);
  }
}

const MAX_SUGGESTIONS = 5;
/**
 * Given [ A, B, C ] return ' Did you mean A, B, or C?'.
 */

function didYouMean(firstArg, secondArg) {
  const [subMessage, suggestionsArg] = secondArg
    ? [firstArg, secondArg]
    : [undefined, firstArg];
  let message = ' Did you mean ';

  if (subMessage) {
    message += subMessage + ' ';
  }

  const suggestions = suggestionsArg.map((x) => `"${x}"`);

  switch (suggestions.length) {
    case 0:
      return '';

    case 1:
      return message + suggestions[0] + '?';

    case 2:
      return message + suggestions[0] + ' or ' + suggestions[1] + '?';
  }

  const selected = suggestions.slice(0, MAX_SUGGESTIONS);
  const lastItem = selected.pop();
  return message + selected.join(', ') + ', or ' + lastItem + '?';
}

/**
 * Returns the first argument it receives.
 */
function identityFunc(x) {
  return x;
}

const MAX_ARRAY_LENGTH = 10;
const MAX_RECURSIVE_DEPTH = 2;
/**
 * Used to print values in error messages.
 */

function inspect(value) {
  return formatValue(value, []);
}

function formatValue(value, seenValues) {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);

    case 'function':
      return value.name ? `[function ${value.name}]` : '[function]';

    case 'object':
      return formatObjectValue(value, seenValues);

    default:
      return String(value);
  }
}

function formatObjectValue(value, previouslySeenValues) {
  if (value === null) {
    return 'null';
  }

  if (previouslySeenValues.includes(value)) {
    return '[Circular]';
  }

  const seenValues = [...previouslySeenValues, value];

  if (isJSONable(value)) {
    const jsonValue = value.toJSON(); // check for infinite recursion

    if (jsonValue !== value) {
      return typeof jsonValue === 'string'
        ? jsonValue
        : formatValue(jsonValue, seenValues);
    }
  } else if (Array.isArray(value)) {
    return formatArray(value, seenValues);
  }

  return formatObject(value, seenValues);
}

function isJSONable(value) {
  return typeof value.toJSON === 'function';
}

function formatObject(object, seenValues) {
  const entries = Object.entries(object);

  if (entries.length === 0) {
    return '{}';
  }

  if (seenValues.length > MAX_RECURSIVE_DEPTH) {
    return '[' + getObjectTag(object) + ']';
  }

  const properties = entries.map(
    ([key, value]) => key + ': ' + formatValue(value, seenValues),
  );
  return '{ ' + properties.join(', ') + ' }';
}

function formatArray(array, seenValues) {
  if (array.length === 0) {
    return '[]';
  }

  if (seenValues.length > MAX_RECURSIVE_DEPTH) {
    return '[Array]';
  }

  const len = Math.min(MAX_ARRAY_LENGTH, array.length);
  const remaining = array.length - len;
  const items = [];

  for (let i = 0; i < len; ++i) {
    items.push(formatValue(array[i], seenValues));
  }

  if (remaining === 1) {
    items.push('... 1 more item');
  } else if (remaining > 1) {
    items.push(`... ${remaining} more items`);
  }

  return '[' + items.join(', ') + ']';
}

function getObjectTag(object) {
  const tag = Object.prototype.toString
    .call(object)
    .replace(/^\[object /, '')
    .replace(/]$/, '');

  if (tag === 'Object' && typeof object.constructor === 'function') {
    const name = object.constructor.name;

    if (typeof name === 'string' && name !== '') {
      return name;
    }
  }

  return tag;
}

/**
 * A replacement for instanceof which includes an error warning when multi-realm
 * constructors are detected.
 * See: https://expressjs.com/en/advanced/best-practice-performance.html#set-node_env-to-production
 * See: https://webpack.js.org/guides/production/
 */

const instanceOf =
  /* c8 ignore next 6 */
  // FIXME: https://github.com/graphql/graphql-js/issues/2317
  globalThis.process && globalThis.process.env.NODE_ENV === 'production'
    ? function instanceOf(value, constructor) {
        return value instanceof constructor;
      }
    : function instanceOf(value, constructor) {
        if (value instanceof constructor) {
          return true;
        }

        if (typeof value === 'object' && value !== null) {
          var _value$constructor;

          // Prefer Symbol.toStringTag since it is immune to minification.
          const className = constructor.prototype[Symbol.toStringTag];
          const valueClassName = // We still need to support constructor's name to detect conflicts with older versions of this library.
            Symbol.toStringTag in value // @ts-expect-error TS bug see, https://github.com/microsoft/TypeScript/issues/38009
              ? value[Symbol.toStringTag]
              : (_value$constructor = value.constructor) === null ||
                _value$constructor === void 0
              ? void 0
              : _value$constructor.name;

          if (className === valueClassName) {
            const stringifiedValue = inspect(value);
            throw new Error(`Cannot use ${className} "${stringifiedValue}" from another module or realm.

Ensure that there is only one instance of "graphql" in the node_modules
directory. If different versions of "graphql" are the dependencies of other
relied on modules, use "resolutions" to ensure only one version is installed.

https://yarnpkg.com/en/docs/selective-version-resolutions

Duplicate "graphql" modules cannot be used at the same time since different
versions may have different capabilities and behavior. The data from one
version used in the function from another could produce confusing and
spurious results.`);
          }
        }

        return false;
      };

/**
 * Return true if `value` is object-like. A value is object-like if it's not
 * `null` and has a `typeof` result of "object".
 */
function isObjectLike(value) {
  return typeof value == 'object' && value !== null;
}

/**
 * Creates a keyed JS object from an array, given a function to produce the keys
 * for each value in the array.
 *
 * This provides a convenient lookup for the array items if the key function
 * produces unique results.
 * ```ts
 * const phoneBook = [
 *   { name: 'Jon', num: '555-1234' },
 *   { name: 'Jenny', num: '867-5309' }
 * ]
 *
 * const entriesByName = keyMap(
 *   phoneBook,
 *   entry => entry.name
 * )
 *
 * // {
 * //   Jon: { name: 'Jon', num: '555-1234' },
 * //   Jenny: { name: 'Jenny', num: '867-5309' }
 * // }
 *
 * const jennyEntry = entriesByName['Jenny']
 *
 * // { name: 'Jenny', num: '857-6309' }
 * ```
 */
function keyMap(list, keyFn) {
  const result = Object.create(null);

  for (const item of list) {
    result[keyFn(item)] = item;
  }

  return result;
}

/**
 * Creates a keyed JS object from an array, given a function to produce the keys
 * and a function to produce the values from each item in the array.
 * ```ts
 * const phoneBook = [
 *   { name: 'Jon', num: '555-1234' },
 *   { name: 'Jenny', num: '867-5309' }
 * ]
 *
 * // { Jon: '555-1234', Jenny: '867-5309' }
 * const phonesByName = keyValMap(
 *   phoneBook,
 *   entry => entry.name,
 *   entry => entry.num
 * )
 * ```
 */
function keyValMap(list, keyFn, valFn) {
  const result = Object.create(null);

  for (const item of list) {
    result[keyFn(item)] = valFn(item);
  }

  return result;
}

/**
 * Creates an object map with the same keys as `map` and values generated by
 * running each value of `map` thru `fn`.
 */
function mapValue(map, fn) {
  const result = Object.create(null);

  for (const key of Object.keys(map)) {
    result[key] = fn(map[key], key);
  }

  return result;
}

/**
 * Returns a number indicating whether a reference string comes before, or after,
 * or is the same as the given string in natural sort order.
 *
 * See: https://en.wikipedia.org/wiki/Natural_sort_order
 *
 */
function naturalCompare(aStr, bStr) {
  let aIndex = 0;
  let bIndex = 0;

  while (aIndex < aStr.length && bIndex < bStr.length) {
    let aChar = aStr.charCodeAt(aIndex);
    let bChar = bStr.charCodeAt(bIndex);

    if (isDigit$1(aChar) && isDigit$1(bChar)) {
      let aNum = 0;

      do {
        ++aIndex;
        aNum = aNum * 10 + aChar - DIGIT_0;
        aChar = aStr.charCodeAt(aIndex);
      } while (isDigit$1(aChar) && aNum > 0);

      let bNum = 0;

      do {
        ++bIndex;
        bNum = bNum * 10 + bChar - DIGIT_0;
        bChar = bStr.charCodeAt(bIndex);
      } while (isDigit$1(bChar) && bNum > 0);

      if (aNum < bNum) {
        return -1;
      }

      if (aNum > bNum) {
        return 1;
      }
    } else {
      if (aChar < bChar) {
        return -1;
      }

      if (aChar > bChar) {
        return 1;
      }

      ++aIndex;
      ++bIndex;
    }
  }

  return aStr.length - bStr.length;
}
const DIGIT_0 = 48;
const DIGIT_9 = 57;

function isDigit$1(code) {
  return !isNaN(code) && DIGIT_0 <= code && code <= DIGIT_9;
}

/**
 * Given an invalid input string and a list of valid options, returns a filtered
 * list of valid options sorted based on their similarity with the input.
 */

function suggestionList(input, options) {
  const optionsByDistance = Object.create(null);
  const lexicalDistance = new LexicalDistance(input);
  const threshold = Math.floor(input.length * 0.4) + 1;

  for (const option of options) {
    const distance = lexicalDistance.measure(option, threshold);

    if (distance !== undefined) {
      optionsByDistance[option] = distance;
    }
  }

  return Object.keys(optionsByDistance).sort((a, b) => {
    const distanceDiff = optionsByDistance[a] - optionsByDistance[b];
    return distanceDiff !== 0 ? distanceDiff : naturalCompare(a, b);
  });
}
/**
 * Computes the lexical distance between strings A and B.
 *
 * The "distance" between two strings is given by counting the minimum number
 * of edits needed to transform string A into string B. An edit can be an
 * insertion, deletion, or substitution of a single character, or a swap of two
 * adjacent characters.
 *
 * Includes a custom alteration from Damerau-Levenshtein to treat case changes
 * as a single edit which helps identify mis-cased values with an edit distance
 * of 1.
 *
 * This distance can be useful for detecting typos in input or sorting
 */

class LexicalDistance {
  constructor(input) {
    this._input = input;
    this._inputLowerCase = input.toLowerCase();
    this._inputArray = stringToArray(this._inputLowerCase);
    this._rows = [
      new Array(input.length + 1).fill(0),
      new Array(input.length + 1).fill(0),
      new Array(input.length + 1).fill(0),
    ];
  }

  measure(option, threshold) {
    if (this._input === option) {
      return 0;
    }

    const optionLowerCase = option.toLowerCase(); // Any case change counts as a single edit

    if (this._inputLowerCase === optionLowerCase) {
      return 1;
    }

    let a = stringToArray(optionLowerCase);
    let b = this._inputArray;

    if (a.length < b.length) {
      const tmp = a;
      a = b;
      b = tmp;
    }

    const aLength = a.length;
    const bLength = b.length;

    if (aLength - bLength > threshold) {
      return undefined;
    }

    const rows = this._rows;

    for (let j = 0; j <= bLength; j++) {
      rows[0][j] = j;
    }

    for (let i = 1; i <= aLength; i++) {
      const upRow = rows[(i - 1) % 3];
      const currentRow = rows[i % 3];
      let smallestCell = (currentRow[0] = i);

      for (let j = 1; j <= bLength; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let currentCell = Math.min(
          upRow[j] + 1, // delete
          currentRow[j - 1] + 1, // insert
          upRow[j - 1] + cost, // substitute
        );

        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          // transposition
          const doubleDiagonalCell = rows[(i - 2) % 3][j - 2];
          currentCell = Math.min(currentCell, doubleDiagonalCell + 1);
        }

        if (currentCell < smallestCell) {
          smallestCell = currentCell;
        }

        currentRow[j] = currentCell;
      } // Early exit, since distance can't go smaller than smallest element of the previous row.

      if (smallestCell > threshold) {
        return undefined;
      }
    }

    const distance = rows[aLength % 3][bLength];
    return distance <= threshold ? distance : undefined;
  }
}

function stringToArray(str) {
  const strLength = str.length;
  const array = new Array(strLength);

  for (let i = 0; i < strLength; ++i) {
    array[i] = str.charCodeAt(i);
  }

  return array;
}

function toObjMap(obj) {
  if (obj == null) {
    return Object.create(null);
  }

  if (Object.getPrototypeOf(obj) === null) {
    return obj;
  }

  const map = Object.create(null);

  for (const [key, value] of Object.entries(obj)) {
    map[key] = value;
  }

  return map;
}

function invariant(condition, message) {
  const booleanCondition = Boolean(condition);

  if (!booleanCondition) {
    throw new Error(
      message != null ? message : 'Unexpected invariant triggered.',
    );
  }
}

const LineRegExp = /\r\n|[\n\r]/g;
/**
 * Represents a location in a Source.
 */

/**
 * Takes a Source and a UTF-8 character offset, and returns the corresponding
 * line and column as a SourceLocation.
 */
function getLocation(source, position) {
  let lastLineStart = 0;
  let line = 1;

  for (const match of source.body.matchAll(LineRegExp)) {
    typeof match.index === 'number' || invariant(false);

    if (match.index >= position) {
      break;
    }

    lastLineStart = match.index + match[0].length;
    line += 1;
  }

  return {
    line,
    column: position + 1 - lastLineStart,
  };
}

/**
 * Render a helpful description of the location in the GraphQL Source document.
 */
function printLocation(location) {
  return printSourceLocation(
    location.source,
    getLocation(location.source, location.start),
  );
}
/**
 * Render a helpful description of the location in the GraphQL Source document.
 */

function printSourceLocation(source, sourceLocation) {
  const firstLineColumnOffset = source.locationOffset.column - 1;
  const body = ''.padStart(firstLineColumnOffset) + source.body;
  const lineIndex = sourceLocation.line - 1;
  const lineOffset = source.locationOffset.line - 1;
  const lineNum = sourceLocation.line + lineOffset;
  const columnOffset = sourceLocation.line === 1 ? firstLineColumnOffset : 0;
  const columnNum = sourceLocation.column + columnOffset;
  const locationStr = `${source.name}:${lineNum}:${columnNum}\n`;
  const lines = body.split(/\r\n|[\n\r]/g);
  const locationLine = lines[lineIndex]; // Special case for minified documents

  if (locationLine.length > 120) {
    const subLineIndex = Math.floor(columnNum / 80);
    const subLineColumnNum = columnNum % 80;
    const subLines = [];

    for (let i = 0; i < locationLine.length; i += 80) {
      subLines.push(locationLine.slice(i, i + 80));
    }

    return (
      locationStr +
      printPrefixedLines([
        [`${lineNum} |`, subLines[0]],
        ...subLines.slice(1, subLineIndex + 1).map((subLine) => ['|', subLine]),
        ['|', '^'.padStart(subLineColumnNum)],
        ['|', subLines[subLineIndex + 1]],
      ])
    );
  }

  return (
    locationStr +
    printPrefixedLines([
      // Lines specified like this: ["prefix", "string"],
      [`${lineNum - 1} |`, lines[lineIndex - 1]],
      [`${lineNum} |`, locationLine],
      ['|', '^'.padStart(columnNum)],
      [`${lineNum + 1} |`, lines[lineIndex + 1]],
    ])
  );
}

function printPrefixedLines(lines) {
  const existingLines = lines.filter(([_, line]) => line !== undefined);
  const padLen = Math.max(...existingLines.map(([prefix]) => prefix.length));
  return existingLines
    .map(([prefix, line]) => prefix.padStart(padLen) + (line ? ' ' + line : ''))
    .join('\n');
}

function toNormalizedOptions(args) {
  const firstArg = args[0];

  if (firstArg == null || 'kind' in firstArg || 'length' in firstArg) {
    return {
      nodes: firstArg,
      source: args[1],
      positions: args[2],
      path: args[3],
      originalError: args[4],
      extensions: args[5],
    };
  }

  return firstArg;
}
/**
 * A GraphQLError describes an Error found during the parse, validate, or
 * execute phases of performing a GraphQL operation. In addition to a message
 * and stack trace, it also includes information about the locations in a
 * GraphQL document and/or execution result that correspond to the Error.
 */

class GraphQLError extends Error {
  /**
   * An array of `{ line, column }` locations within the source GraphQL document
   * which correspond to this error.
   *
   * Errors during validation often contain multiple locations, for example to
   * point out two things with the same name. Errors during execution include a
   * single location, the field which produced the error.
   *
   * Enumerable, and appears in the result of JSON.stringify().
   */

  /**
   * An array describing the JSON-path into the execution response which
   * corresponds to this error. Only included for errors during execution.
   *
   * Enumerable, and appears in the result of JSON.stringify().
   */

  /**
   * An array of GraphQL AST Nodes corresponding to this error.
   */

  /**
   * The source GraphQL document for the first location of this error.
   *
   * Note that if this Error represents more than one node, the source may not
   * represent nodes after the first node.
   */

  /**
   * An array of character offsets within the source GraphQL document
   * which correspond to this error.
   */

  /**
   * The original error thrown from a field resolver during execution.
   */

  /**
   * Extension fields to add to the formatted error.
   */

  /**
   * @deprecated Please use the `GraphQLErrorOptions` constructor overload instead.
   */
  constructor(message, ...rawArgs) {
    var _this$nodes, _nodeLocations$, _ref;

    const { nodes, source, positions, path, originalError, extensions } =
      toNormalizedOptions(rawArgs);
    super(message);
    this.name = 'GraphQLError';
    this.path = path !== null && path !== void 0 ? path : undefined;
    this.originalError =
      originalError !== null && originalError !== void 0
        ? originalError
        : undefined; // Compute list of blame nodes.

    this.nodes = undefinedIfEmpty(
      Array.isArray(nodes) ? nodes : nodes ? [nodes] : undefined,
    );
    const nodeLocations = undefinedIfEmpty(
      (_this$nodes = this.nodes) === null || _this$nodes === void 0
        ? void 0
        : _this$nodes.map((node) => node.loc).filter((loc) => loc != null),
    ); // Compute locations in the source for the given nodes/positions.

    this.source =
      source !== null && source !== void 0
        ? source
        : nodeLocations === null || nodeLocations === void 0
        ? void 0
        : (_nodeLocations$ = nodeLocations[0]) === null ||
          _nodeLocations$ === void 0
        ? void 0
        : _nodeLocations$.source;
    this.positions =
      positions !== null && positions !== void 0
        ? positions
        : nodeLocations === null || nodeLocations === void 0
        ? void 0
        : nodeLocations.map((loc) => loc.start);
    this.locations =
      positions && source
        ? positions.map((pos) => getLocation(source, pos))
        : nodeLocations === null || nodeLocations === void 0
        ? void 0
        : nodeLocations.map((loc) => getLocation(loc.source, loc.start));
    const originalExtensions = isObjectLike(
      originalError === null || originalError === void 0
        ? void 0
        : originalError.extensions,
    )
      ? originalError === null || originalError === void 0
        ? void 0
        : originalError.extensions
      : undefined;
    this.extensions =
      (_ref =
        extensions !== null && extensions !== void 0
          ? extensions
          : originalExtensions) !== null && _ref !== void 0
        ? _ref
        : Object.create(null); // Only properties prescribed by the spec should be enumerable.
    // Keep the rest as non-enumerable.

    Object.defineProperties(this, {
      message: {
        writable: true,
        enumerable: true,
      },
      name: {
        enumerable: false,
      },
      nodes: {
        enumerable: false,
      },
      source: {
        enumerable: false,
      },
      positions: {
        enumerable: false,
      },
      originalError: {
        enumerable: false,
      },
    }); // Include (non-enumerable) stack trace.

    /* c8 ignore start */
    // FIXME: https://github.com/graphql/graphql-js/issues/2317

    if (
      originalError !== null &&
      originalError !== void 0 &&
      originalError.stack
    ) {
      Object.defineProperty(this, 'stack', {
        value: originalError.stack,
        writable: true,
        configurable: true,
      });
    } else if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GraphQLError);
    } else {
      Object.defineProperty(this, 'stack', {
        value: Error().stack,
        writable: true,
        configurable: true,
      });
    }
    /* c8 ignore stop */
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLError';
  }

  toString() {
    let output = this.message;

    if (this.nodes) {
      for (const node of this.nodes) {
        if (node.loc) {
          output += '\n\n' + printLocation(node.loc);
        }
      }
    } else if (this.source && this.locations) {
      for (const location of this.locations) {
        output += '\n\n' + printSourceLocation(this.source, location);
      }
    }

    return output;
  }

  toJSON() {
    const formattedError = {
      message: this.message,
    };

    if (this.locations != null) {
      formattedError.locations = this.locations;
    }

    if (this.path != null) {
      formattedError.path = this.path;
    }

    if (this.extensions != null && Object.keys(this.extensions).length > 0) {
      formattedError.extensions = this.extensions;
    }

    return formattedError;
  }
}

function undefinedIfEmpty(array) {
  return array === undefined || array.length === 0 ? undefined : array;
}

/**
 * ```
 * WhiteSpace ::
 *   - "Horizontal Tab (U+0009)"
 *   - "Space (U+0020)"
 * ```
 * @internal
 */
function isWhiteSpace(code) {
  return code === 0x0009 || code === 0x0020;
}
/**
 * ```
 * Digit :: one of
 *   - `0` `1` `2` `3` `4` `5` `6` `7` `8` `9`
 * ```
 * @internal
 */

function isDigit(code) {
  return code >= 0x0030 && code <= 0x0039;
}
/**
 * ```
 * Letter :: one of
 *   - `A` `B` `C` `D` `E` `F` `G` `H` `I` `J` `K` `L` `M`
 *   - `N` `O` `P` `Q` `R` `S` `T` `U` `V` `W` `X` `Y` `Z`
 *   - `a` `b` `c` `d` `e` `f` `g` `h` `i` `j` `k` `l` `m`
 *   - `n` `o` `p` `q` `r` `s` `t` `u` `v` `w` `x` `y` `z`
 * ```
 * @internal
 */

function isLetter(code) {
  return (
    (code >= 0x0061 && code <= 0x007a) || // A-Z
    (code >= 0x0041 && code <= 0x005a) // a-z
  );
}
/**
 * ```
 * NameStart ::
 *   - Letter
 *   - `_`
 * ```
 * @internal
 */

function isNameStart(code) {
  return isLetter(code) || code === 0x005f;
}
/**
 * ```
 * NameContinue ::
 *   - Letter
 *   - Digit
 *   - `_`
 * ```
 * @internal
 */

function isNameContinue(code) {
  return isLetter(code) || isDigit(code) || code === 0x005f;
}

/**
 * Print a block string in the indented block form by adding a leading and
 * trailing blank line. However, if a block string starts with whitespace and is
 * a single-line, adding a leading blank line would strip that whitespace.
 *
 * @internal
 */

function printBlockString(value, options) {
  const escapedValue = value.replace(/"""/g, '\\"""'); // Expand a block string's raw value into independent lines.

  const lines = escapedValue.split(/\r\n|[\n\r]/g);
  const isSingleLine = lines.length === 1; // If common indentation is found we can fix some of those cases by adding leading new line

  const forceLeadingNewLine =
    lines.length > 1 &&
    lines
      .slice(1)
      .every((line) => line.length === 0 || isWhiteSpace(line.charCodeAt(0))); // Trailing triple quotes just looks confusing but doesn't force trailing new line

  const hasTrailingTripleQuotes = escapedValue.endsWith('\\"""'); // Trailing quote (single or double) or slash forces trailing new line

  const hasTrailingQuote = value.endsWith('"') && !hasTrailingTripleQuotes;
  const hasTrailingSlash = value.endsWith('\\');
  const forceTrailingNewline = hasTrailingQuote || hasTrailingSlash;
  const printAsMultipleLines =
    !(options !== null && options !== void 0 && options.minimize) && // add leading and trailing new lines only if it improves readability
    (!isSingleLine ||
      value.length > 70 ||
      forceTrailingNewline ||
      forceLeadingNewLine ||
      hasTrailingTripleQuotes);
  let result = ''; // Format a multi-line block quote to account for leading space.

  const skipLeadingNewLine = isSingleLine && isWhiteSpace(value.charCodeAt(0));

  if ((printAsMultipleLines && !skipLeadingNewLine) || forceLeadingNewLine) {
    result += '\n';
  }

  result += escapedValue;

  if (printAsMultipleLines || forceTrailingNewline) {
    result += '\n';
  }

  return '"""' + result + '"""';
}

/**
 * Prints a string as a GraphQL StringValue literal. Replaces control characters
 * and excluded characters (" U+0022 and \\ U+005C) with escape sequences.
 */
function printString(str) {
  return `"${str.replace(escapedRegExp, escapedReplacer)}"`;
} // eslint-disable-next-line no-control-regex

const escapedRegExp = /[\x00-\x1f\x22\x5c\x7f-\x9f]/g;

function escapedReplacer(str) {
  return escapeSequences[str.charCodeAt(0)];
} // prettier-ignore

const escapeSequences = [
  '\\u0000',
  '\\u0001',
  '\\u0002',
  '\\u0003',
  '\\u0004',
  '\\u0005',
  '\\u0006',
  '\\u0007',
  '\\b',
  '\\t',
  '\\n',
  '\\u000B',
  '\\f',
  '\\r',
  '\\u000E',
  '\\u000F',
  '\\u0010',
  '\\u0011',
  '\\u0012',
  '\\u0013',
  '\\u0014',
  '\\u0015',
  '\\u0016',
  '\\u0017',
  '\\u0018',
  '\\u0019',
  '\\u001A',
  '\\u001B',
  '\\u001C',
  '\\u001D',
  '\\u001E',
  '\\u001F',
  '',
  '',
  '\\"',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '', // 2F
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '', // 3F
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '', // 4F
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '\\\\',
  '',
  '',
  '', // 5F
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '', // 6F
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '\\u007F',
  '\\u0080',
  '\\u0081',
  '\\u0082',
  '\\u0083',
  '\\u0084',
  '\\u0085',
  '\\u0086',
  '\\u0087',
  '\\u0088',
  '\\u0089',
  '\\u008A',
  '\\u008B',
  '\\u008C',
  '\\u008D',
  '\\u008E',
  '\\u008F',
  '\\u0090',
  '\\u0091',
  '\\u0092',
  '\\u0093',
  '\\u0094',
  '\\u0095',
  '\\u0096',
  '\\u0097',
  '\\u0098',
  '\\u0099',
  '\\u009A',
  '\\u009B',
  '\\u009C',
  '\\u009D',
  '\\u009E',
  '\\u009F',
];

/**
 * Contains a range of UTF-8 character offsets and token references that
 * identify the region of the source from which the AST derived.
 */
/**
 * The list of all possible AST node types.
 */

/**
 * @internal
 */
const QueryDocumentKeys = {
  Name: [],
  Document: ['definitions'],
  OperationDefinition: [
    'name',
    'variableDefinitions',
    'directives',
    'selectionSet',
  ],
  VariableDefinition: ['variable', 'type', 'defaultValue', 'directives'],
  Variable: ['name'],
  SelectionSet: ['selections'],
  Field: ['alias', 'name', 'arguments', 'directives', 'selectionSet'],
  Argument: ['name', 'value'],
  FragmentSpread: ['name', 'directives'],
  InlineFragment: ['typeCondition', 'directives', 'selectionSet'],
  FragmentDefinition: [
    'name', // Note: fragment variable definitions are deprecated and will removed in v17.0.0
    'variableDefinitions',
    'typeCondition',
    'directives',
    'selectionSet',
  ],
  IntValue: [],
  FloatValue: [],
  StringValue: [],
  BooleanValue: [],
  NullValue: [],
  EnumValue: [],
  ListValue: ['values'],
  ObjectValue: ['fields'],
  ObjectField: ['name', 'value'],
  Directive: ['name', 'arguments'],
  NamedType: ['name'],
  ListType: ['type'],
  NonNullType: ['type'],
  SchemaDefinition: ['description', 'directives', 'operationTypes'],
  OperationTypeDefinition: ['type'],
  ScalarTypeDefinition: ['description', 'name', 'directives'],
  ObjectTypeDefinition: [
    'description',
    'name',
    'interfaces',
    'directives',
    'fields',
  ],
  FieldDefinition: ['description', 'name', 'arguments', 'type', 'directives'],
  InputValueDefinition: [
    'description',
    'name',
    'type',
    'defaultValue',
    'directives',
  ],
  InterfaceTypeDefinition: [
    'description',
    'name',
    'interfaces',
    'directives',
    'fields',
  ],
  UnionTypeDefinition: ['description', 'name', 'directives', 'types'],
  EnumTypeDefinition: ['description', 'name', 'directives', 'values'],
  EnumValueDefinition: ['description', 'name', 'directives'],
  InputObjectTypeDefinition: ['description', 'name', 'directives', 'fields'],
  DirectiveDefinition: ['description', 'name', 'arguments', 'locations'],
  SchemaExtension: ['directives', 'operationTypes'],
  ScalarTypeExtension: ['name', 'directives'],
  ObjectTypeExtension: ['name', 'interfaces', 'directives', 'fields'],
  InterfaceTypeExtension: ['name', 'interfaces', 'directives', 'fields'],
  UnionTypeExtension: ['name', 'directives', 'types'],
  EnumTypeExtension: ['name', 'directives', 'values'],
  InputObjectTypeExtension: ['name', 'directives', 'fields'],
};
const kindValues = new Set(Object.keys(QueryDocumentKeys));
/**
 * @internal
 */

function isNode(maybeNode) {
  const maybeKind =
    maybeNode === null || maybeNode === void 0 ? void 0 : maybeNode.kind;
  return typeof maybeKind === 'string' && kindValues.has(maybeKind);
}
/** Name */

var OperationTypeNode;

(function (OperationTypeNode) {
  OperationTypeNode['QUERY'] = 'query';
  OperationTypeNode['MUTATION'] = 'mutation';
  OperationTypeNode['SUBSCRIPTION'] = 'subscription';
})(OperationTypeNode || (OperationTypeNode = {}));

/**
 * A visitor is provided to visit, it contains the collection of
 * relevant functions to be called during the visitor's traversal.
 */

const BREAK = Object.freeze({});
/**
 * visit() will walk through an AST using a depth-first traversal, calling
 * the visitor's enter function at each node in the traversal, and calling the
 * leave function after visiting that node and all of its child nodes.
 *
 * By returning different values from the enter and leave functions, the
 * behavior of the visitor can be altered, including skipping over a sub-tree of
 * the AST (by returning false), editing the AST by returning a value or null
 * to remove the value, or to stop the whole traversal by returning BREAK.
 *
 * When using visit() to edit an AST, the original AST will not be modified, and
 * a new version of the AST with the changes applied will be returned from the
 * visit function.
 *
 * ```ts
 * const editedAST = visit(ast, {
 *   enter(node, key, parent, path, ancestors) {
 *     // @return
 *     //   undefined: no action
 *     //   false: skip visiting this node
 *     //   visitor.BREAK: stop visiting altogether
 *     //   null: delete this node
 *     //   any value: replace this node with the returned value
 *   },
 *   leave(node, key, parent, path, ancestors) {
 *     // @return
 *     //   undefined: no action
 *     //   false: no action
 *     //   visitor.BREAK: stop visiting altogether
 *     //   null: delete this node
 *     //   any value: replace this node with the returned value
 *   }
 * });
 * ```
 *
 * Alternatively to providing enter() and leave() functions, a visitor can
 * instead provide functions named the same as the kinds of AST nodes, or
 * enter/leave visitors at a named key, leading to three permutations of the
 * visitor API:
 *
 * 1) Named visitors triggered when entering a node of a specific kind.
 *
 * ```ts
 * visit(ast, {
 *   Kind(node) {
 *     // enter the "Kind" node
 *   }
 * })
 * ```
 *
 * 2) Named visitors that trigger upon entering and leaving a node of a specific kind.
 *
 * ```ts
 * visit(ast, {
 *   Kind: {
 *     enter(node) {
 *       // enter the "Kind" node
 *     }
 *     leave(node) {
 *       // leave the "Kind" node
 *     }
 *   }
 * })
 * ```
 *
 * 3) Generic visitors that trigger upon entering and leaving any node.
 *
 * ```ts
 * visit(ast, {
 *   enter(node) {
 *     // enter any node
 *   },
 *   leave(node) {
 *     // leave any node
 *   }
 * })
 * ```
 */

function visit(root, visitor, visitorKeys = QueryDocumentKeys) {
  const enterLeaveMap = new Map();

  for (const kind of Object.values(Kind)) {
    enterLeaveMap.set(kind, getEnterLeaveForKind(visitor, kind));
  }
  /* eslint-disable no-undef-init */

  let stack = undefined;
  let inArray = Array.isArray(root);
  let keys = [root];
  let index = -1;
  let edits = [];
  let node = root;
  let key = undefined;
  let parent = undefined;
  const path = [];
  const ancestors = [];
  /* eslint-enable no-undef-init */

  do {
    index++;
    const isLeaving = index === keys.length;
    const isEdited = isLeaving && edits.length !== 0;

    if (isLeaving) {
      key = ancestors.length === 0 ? undefined : path[path.length - 1];
      node = parent;
      parent = ancestors.pop();

      if (isEdited) {
        if (inArray) {
          node = node.slice();
          let editOffset = 0;

          for (const [editKey, editValue] of edits) {
            const arrayKey = editKey - editOffset;

            if (editValue === null) {
              node.splice(arrayKey, 1);
              editOffset++;
            } else {
              node[arrayKey] = editValue;
            }
          }
        } else {
          node = Object.defineProperties(
            {},
            Object.getOwnPropertyDescriptors(node),
          );

          for (const [editKey, editValue] of edits) {
            node[editKey] = editValue;
          }
        }
      }

      index = stack.index;
      keys = stack.keys;
      edits = stack.edits;
      inArray = stack.inArray;
      stack = stack.prev;
    } else if (parent) {
      key = inArray ? index : keys[index];
      node = parent[key];

      if (node === null || node === undefined) {
        continue;
      }

      path.push(key);
    }

    let result;

    if (!Array.isArray(node)) {
      var _enterLeaveMap$get, _enterLeaveMap$get2;

      isNode(node) || devAssert(false, `Invalid AST Node: ${inspect(node)}.`);
      const visitFn = isLeaving
        ? (_enterLeaveMap$get = enterLeaveMap.get(node.kind)) === null ||
          _enterLeaveMap$get === void 0
          ? void 0
          : _enterLeaveMap$get.leave
        : (_enterLeaveMap$get2 = enterLeaveMap.get(node.kind)) === null ||
          _enterLeaveMap$get2 === void 0
        ? void 0
        : _enterLeaveMap$get2.enter;
      result =
        visitFn === null || visitFn === void 0
          ? void 0
          : visitFn.call(visitor, node, key, parent, path, ancestors);

      if (result === BREAK) {
        break;
      }

      if (result === false) {
        if (!isLeaving) {
          path.pop();
          continue;
        }
      } else if (result !== undefined) {
        edits.push([key, result]);

        if (!isLeaving) {
          if (isNode(result)) {
            node = result;
          } else {
            path.pop();
            continue;
          }
        }
      }
    }

    if (result === undefined && isEdited) {
      edits.push([key, node]);
    }

    if (isLeaving) {
      path.pop();
    } else {
      var _node$kind;

      stack = {
        inArray,
        index,
        keys,
        edits,
        prev: stack,
      };
      inArray = Array.isArray(node);
      keys = inArray
        ? node
        : (_node$kind = visitorKeys[node.kind]) !== null &&
          _node$kind !== void 0
        ? _node$kind
        : [];
      index = -1;
      edits = [];

      if (parent) {
        ancestors.push(parent);
      }

      parent = node;
    }
  } while (stack !== undefined);

  if (edits.length !== 0) {
    // New root
    return edits[edits.length - 1][1];
  }

  return root;
}
/**
 * Given a visitor instance and a node kind, return EnterLeaveVisitor for that kind.
 */

function getEnterLeaveForKind(visitor, kind) {
  const kindVisitor = visitor[kind];

  if (typeof kindVisitor === 'object') {
    // { Kind: { enter() {}, leave() {} } }
    return kindVisitor;
  } else if (typeof kindVisitor === 'function') {
    // { Kind() {} }
    return {
      enter: kindVisitor,
      leave: undefined,
    };
  } // { enter() {}, leave() {} }

  return {
    enter: visitor.enter,
    leave: visitor.leave,
  };
}

/**
 * Converts an AST into a string, using one set of reasonable
 * formatting rules.
 */

function print(ast) {
  return visit(ast, printDocASTReducer);
}
const MAX_LINE_LENGTH = 80;
const printDocASTReducer = {
  Name: {
    leave: (node) => node.value,
  },
  Variable: {
    leave: (node) => '$' + node.name,
  },
  // Document
  Document: {
    leave: (node) => join(node.definitions, '\n\n'),
  },
  OperationDefinition: {
    leave(node) {
      const varDefs = wrap('(', join(node.variableDefinitions, ', '), ')');
      const prefix = join(
        [
          node.operation,
          join([node.name, varDefs]),
          join(node.directives, ' '),
        ],
        ' ',
      ); // Anonymous queries with no directives or variable definitions can use
      // the query short form.

      return (prefix === 'query' ? '' : prefix + ' ') + node.selectionSet;
    },
  },
  VariableDefinition: {
    leave: ({ variable, type, defaultValue, directives }) =>
      variable +
      ': ' +
      type +
      wrap(' = ', defaultValue) +
      wrap(' ', join(directives, ' ')),
  },
  SelectionSet: {
    leave: ({ selections }) => block(selections),
  },
  Field: {
    leave({ alias, name, arguments: args, directives, selectionSet }) {
      const prefix = wrap('', alias, ': ') + name;
      let argsLine = prefix + wrap('(', join(args, ', '), ')');

      if (argsLine.length > MAX_LINE_LENGTH) {
        argsLine = prefix + wrap('(\n', indent(join(args, '\n')), '\n)');
      }

      return join([argsLine, join(directives, ' '), selectionSet], ' ');
    },
  },
  Argument: {
    leave: ({ name, value }) => name + ': ' + value,
  },
  // Fragments
  FragmentSpread: {
    leave: ({ name, directives }) =>
      '...' + name + wrap(' ', join(directives, ' ')),
  },
  InlineFragment: {
    leave: ({ typeCondition, directives, selectionSet }) =>
      join(
        [
          '...',
          wrap('on ', typeCondition),
          join(directives, ' '),
          selectionSet,
        ],
        ' ',
      ),
  },
  FragmentDefinition: {
    leave: (
      { name, typeCondition, variableDefinitions, directives, selectionSet }, // Note: fragment variable definitions are experimental and may be changed
    ) =>
      // or removed in the future.
      `fragment ${name}${wrap('(', join(variableDefinitions, ', '), ')')} ` +
      `on ${typeCondition} ${wrap('', join(directives, ' '), ' ')}` +
      selectionSet,
  },
  // Value
  IntValue: {
    leave: ({ value }) => value,
  },
  FloatValue: {
    leave: ({ value }) => value,
  },
  StringValue: {
    leave: ({ value, block: isBlockString }) =>
      isBlockString ? printBlockString(value) : printString(value),
  },
  BooleanValue: {
    leave: ({ value }) => (value ? 'true' : 'false'),
  },
  NullValue: {
    leave: () => 'null',
  },
  EnumValue: {
    leave: ({ value }) => value,
  },
  ListValue: {
    leave: ({ values }) => '[' + join(values, ', ') + ']',
  },
  ObjectValue: {
    leave: ({ fields }) => '{' + join(fields, ', ') + '}',
  },
  ObjectField: {
    leave: ({ name, value }) => name + ': ' + value,
  },
  // Directive
  Directive: {
    leave: ({ name, arguments: args }) =>
      '@' + name + wrap('(', join(args, ', '), ')'),
  },
  // Type
  NamedType: {
    leave: ({ name }) => name,
  },
  ListType: {
    leave: ({ type }) => '[' + type + ']',
  },
  NonNullType: {
    leave: ({ type }) => type + '!',
  },
  // Type System Definitions
  SchemaDefinition: {
    leave: ({ description, directives, operationTypes }) =>
      wrap('', description, '\n') +
      join(['schema', join(directives, ' '), block(operationTypes)], ' '),
  },
  OperationTypeDefinition: {
    leave: ({ operation, type }) => operation + ': ' + type,
  },
  ScalarTypeDefinition: {
    leave: ({ description, name, directives }) =>
      wrap('', description, '\n') +
      join(['scalar', name, join(directives, ' ')], ' '),
  },
  ObjectTypeDefinition: {
    leave: ({ description, name, interfaces, directives, fields }) =>
      wrap('', description, '\n') +
      join(
        [
          'type',
          name,
          wrap('implements ', join(interfaces, ' & ')),
          join(directives, ' '),
          block(fields),
        ],
        ' ',
      ),
  },
  FieldDefinition: {
    leave: ({ description, name, arguments: args, type, directives }) =>
      wrap('', description, '\n') +
      name +
      (hasMultilineItems(args)
        ? wrap('(\n', indent(join(args, '\n')), '\n)')
        : wrap('(', join(args, ', '), ')')) +
      ': ' +
      type +
      wrap(' ', join(directives, ' ')),
  },
  InputValueDefinition: {
    leave: ({ description, name, type, defaultValue, directives }) =>
      wrap('', description, '\n') +
      join(
        [name + ': ' + type, wrap('= ', defaultValue), join(directives, ' ')],
        ' ',
      ),
  },
  InterfaceTypeDefinition: {
    leave: ({ description, name, interfaces, directives, fields }) =>
      wrap('', description, '\n') +
      join(
        [
          'interface',
          name,
          wrap('implements ', join(interfaces, ' & ')),
          join(directives, ' '),
          block(fields),
        ],
        ' ',
      ),
  },
  UnionTypeDefinition: {
    leave: ({ description, name, directives, types }) =>
      wrap('', description, '\n') +
      join(
        ['union', name, join(directives, ' '), wrap('= ', join(types, ' | '))],
        ' ',
      ),
  },
  EnumTypeDefinition: {
    leave: ({ description, name, directives, values }) =>
      wrap('', description, '\n') +
      join(['enum', name, join(directives, ' '), block(values)], ' '),
  },
  EnumValueDefinition: {
    leave: ({ description, name, directives }) =>
      wrap('', description, '\n') + join([name, join(directives, ' ')], ' '),
  },
  InputObjectTypeDefinition: {
    leave: ({ description, name, directives, fields }) =>
      wrap('', description, '\n') +
      join(['input', name, join(directives, ' '), block(fields)], ' '),
  },
  DirectiveDefinition: {
    leave: ({ description, name, arguments: args, repeatable, locations }) =>
      wrap('', description, '\n') +
      'directive @' +
      name +
      (hasMultilineItems(args)
        ? wrap('(\n', indent(join(args, '\n')), '\n)')
        : wrap('(', join(args, ', '), ')')) +
      (repeatable ? ' repeatable' : '') +
      ' on ' +
      join(locations, ' | '),
  },
  SchemaExtension: {
    leave: ({ directives, operationTypes }) =>
      join(
        ['extend schema', join(directives, ' '), block(operationTypes)],
        ' ',
      ),
  },
  ScalarTypeExtension: {
    leave: ({ name, directives }) =>
      join(['extend scalar', name, join(directives, ' ')], ' '),
  },
  ObjectTypeExtension: {
    leave: ({ name, interfaces, directives, fields }) =>
      join(
        [
          'extend type',
          name,
          wrap('implements ', join(interfaces, ' & ')),
          join(directives, ' '),
          block(fields),
        ],
        ' ',
      ),
  },
  InterfaceTypeExtension: {
    leave: ({ name, interfaces, directives, fields }) =>
      join(
        [
          'extend interface',
          name,
          wrap('implements ', join(interfaces, ' & ')),
          join(directives, ' '),
          block(fields),
        ],
        ' ',
      ),
  },
  UnionTypeExtension: {
    leave: ({ name, directives, types }) =>
      join(
        [
          'extend union',
          name,
          join(directives, ' '),
          wrap('= ', join(types, ' | ')),
        ],
        ' ',
      ),
  },
  EnumTypeExtension: {
    leave: ({ name, directives, values }) =>
      join(['extend enum', name, join(directives, ' '), block(values)], ' '),
  },
  InputObjectTypeExtension: {
    leave: ({ name, directives, fields }) =>
      join(['extend input', name, join(directives, ' '), block(fields)], ' '),
  },
};
/**
 * Given maybeArray, print an empty string if it is null or empty, otherwise
 * print all items together separated by separator if provided
 */

function join(maybeArray, separator = '') {
  var _maybeArray$filter$jo;

  return (_maybeArray$filter$jo =
    maybeArray === null || maybeArray === void 0
      ? void 0
      : maybeArray.filter((x) => x).join(separator)) !== null &&
    _maybeArray$filter$jo !== void 0
    ? _maybeArray$filter$jo
    : '';
}
/**
 * Given array, print each item on its own line, wrapped in an indented `{ }` block.
 */

function block(array) {
  return wrap('{\n', indent(join(array, '\n')), '\n}');
}
/**
 * If maybeString is not null or empty, then wrap with start and end, otherwise print an empty string.
 */

function wrap(start, maybeString, end = '') {
  return maybeString != null && maybeString !== ''
    ? start + maybeString + end
    : '';
}

function indent(str) {
  return wrap('  ', str.replace(/\n/g, '\n  '));
}

function hasMultilineItems(maybeArray) {
  var _maybeArray$some;

  // FIXME: https://github.com/graphql/graphql-js/issues/2203

  /* c8 ignore next */
  return (_maybeArray$some =
    maybeArray === null || maybeArray === void 0
      ? void 0
      : maybeArray.some((str) => str.includes('\n'))) !== null &&
    _maybeArray$some !== void 0
    ? _maybeArray$some
    : false;
}

/**
 * Produces a JavaScript value given a GraphQL Value AST.
 *
 * Unlike `valueFromAST()`, no type is provided. The resulting JavaScript value
 * will reflect the provided GraphQL value AST.
 *
 * | GraphQL Value        | JavaScript Value |
 * | -------------------- | ---------------- |
 * | Input Object         | Object           |
 * | List                 | Array            |
 * | Boolean              | Boolean          |
 * | String / Enum        | String           |
 * | Int / Float          | Number           |
 * | Null                 | null             |
 *
 */

function valueFromASTUntyped(valueNode, variables) {
  switch (valueNode.kind) {
    case Kind.NULL:
      return null;

    case Kind.INT:
      return parseInt(valueNode.value, 10);

    case Kind.FLOAT:
      return parseFloat(valueNode.value);

    case Kind.STRING:
    case Kind.ENUM:
    case Kind.BOOLEAN:
      return valueNode.value;

    case Kind.LIST:
      return valueNode.values.map((node) =>
        valueFromASTUntyped(node, variables),
      );

    case Kind.OBJECT:
      return keyValMap(
        valueNode.fields,
        (field) => field.name.value,
        (field) => valueFromASTUntyped(field.value, variables),
      );

    case Kind.VARIABLE:
      return variables === null || variables === void 0
        ? void 0
        : variables[valueNode.name.value];
  }
}

/**
 * Upholds the spec rules about naming.
 */

function assertName(name) {
  name != null || devAssert(false, 'Must provide name.');
  typeof name === 'string' || devAssert(false, 'Expected name to be a string.');

  if (name.length === 0) {
    throw new GraphQLError('Expected name to be a non-empty string.');
  }

  for (let i = 1; i < name.length; ++i) {
    if (!isNameContinue(name.charCodeAt(i))) {
      throw new GraphQLError(
        `Names must only contain [_a-zA-Z0-9] but "${name}" does not.`,
      );
    }
  }

  if (!isNameStart(name.charCodeAt(0))) {
    throw new GraphQLError(
      `Names must start with [_a-zA-Z] but "${name}" does not.`,
    );
  }

  return name;
}
/**
 * Upholds the spec rules about naming enum values.
 *
 * @internal
 */

function assertEnumValueName(name) {
  if (name === 'true' || name === 'false' || name === 'null') {
    throw new GraphQLError(`Enum values cannot be named: ${name}`);
  }

  return assertName(name);
}

function isType(type) {
  return (
    isScalarType(type) ||
    isObjectType(type) ||
    isInterfaceType(type) ||
    isUnionType(type) ||
    isEnumType(type) ||
    isInputObjectType(type) ||
    isListType(type) ||
    isNonNullType(type)
  );
}
/**
 * There are predicates for each kind of GraphQL type.
 */

function isScalarType(type) {
  return instanceOf(type, GraphQLScalarType);
}
function isObjectType(type) {
  return instanceOf(type, GraphQLObjectType);
}
function isInterfaceType(type) {
  return instanceOf(type, GraphQLInterfaceType);
}
function isUnionType(type) {
  return instanceOf(type, GraphQLUnionType);
}
function isEnumType(type) {
  return instanceOf(type, GraphQLEnumType);
}
function isInputObjectType(type) {
  return instanceOf(type, GraphQLInputObjectType);
}
function isListType(type) {
  return instanceOf(type, GraphQLList);
}
function isNonNullType(type) {
  return instanceOf(type, GraphQLNonNull);
}
/**
 * These types may describe types which may be leaf values.
 */

function isLeafType(type) {
  return isScalarType(type) || isEnumType(type);
}
/**
 * These types may describe the parent context of a selection set.
 */

function isAbstractType(type) {
  return isInterfaceType(type) || isUnionType(type);
}
/**
 * List Type Wrapper
 *
 * A list is a wrapping type which points to another type.
 * Lists are often created within the context of defining the fields of
 * an object type.
 *
 * Example:
 *
 * ```ts
 * const PersonType = new GraphQLObjectType({
 *   name: 'Person',
 *   fields: () => ({
 *     parents: { type: new GraphQLList(PersonType) },
 *     children: { type: new GraphQLList(PersonType) },
 *   })
 * })
 * ```
 */

class GraphQLList {
  constructor(ofType) {
    isType(ofType) ||
      devAssert(false, `Expected ${inspect(ofType)} to be a GraphQL type.`);
    this.ofType = ofType;
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLList';
  }

  toString() {
    return '[' + String(this.ofType) + ']';
  }

  toJSON() {
    return this.toString();
  }
}
/**
 * Non-Null Type Wrapper
 *
 * A non-null is a wrapping type which points to another type.
 * Non-null types enforce that their values are never null and can ensure
 * an error is raised if this ever occurs during a request. It is useful for
 * fields which you can make a strong guarantee on non-nullability, for example
 * usually the id field of a database row will never be null.
 *
 * Example:
 *
 * ```ts
 * const RowType = new GraphQLObjectType({
 *   name: 'Row',
 *   fields: () => ({
 *     id: { type: new GraphQLNonNull(GraphQLString) },
 *   })
 * })
 * ```
 * Note: the enforcement of non-nullability occurs within the executor.
 */

class GraphQLNonNull {
  constructor(ofType) {
    isNullableType(ofType) ||
      devAssert(
        false,
        `Expected ${inspect(ofType)} to be a GraphQL nullable type.`,
      );
    this.ofType = ofType;
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLNonNull';
  }

  toString() {
    return String(this.ofType) + '!';
  }

  toJSON() {
    return this.toString();
  }
}
/**
 * These types can all accept null as a value.
 */

function isNullableType(type) {
  return isType(type) && !isNonNullType(type);
}
/**
 * Used while defining GraphQL types to allow for circular references in
 * otherwise immutable type definitions.
 */

function resolveReadonlyArrayThunk(thunk) {
  return typeof thunk === 'function' ? thunk() : thunk;
}
function resolveObjMapThunk(thunk) {
  return typeof thunk === 'function' ? thunk() : thunk;
}
/**
 * Custom extensions
 *
 * @remarks
 * Use a unique identifier name for your extension, for example the name of
 * your library or project. Do not use a shortened identifier as this increases
 * the risk of conflicts. We recommend you add at most one extension field,
 * an object which can contain all the values you need.
 */

/**
 * Scalar Type Definition
 *
 * The leaf values of any request and input values to arguments are
 * Scalars (or Enums) and are defined with a name and a series of functions
 * used to parse input from ast or variables and to ensure validity.
 *
 * If a type's serialize function returns `null` or does not return a value
 * (i.e. it returns `undefined`) then an error will be raised and a `null`
 * value will be returned in the response. It is always better to validate
 *
 * Example:
 *
 * ```ts
 * const OddType = new GraphQLScalarType({
 *   name: 'Odd',
 *   serialize(value) {
 *     if (!Number.isFinite(value)) {
 *       throw new Error(
 *         `Scalar "Odd" cannot represent "${value}" since it is not a finite number.`,
 *       );
 *     }
 *
 *     if (value % 2 === 0) {
 *       throw new Error(`Scalar "Odd" cannot represent "${value}" since it is even.`);
 *     }
 *     return value;
 *   }
 * });
 * ```
 */
class GraphQLScalarType {
  constructor(config) {
    var _config$parseValue,
      _config$serialize,
      _config$parseLiteral,
      _config$extensionASTN;

    const parseValue =
      (_config$parseValue = config.parseValue) !== null &&
      _config$parseValue !== void 0
        ? _config$parseValue
        : identityFunc;
    this.name = assertName(config.name);
    this.description = config.description;
    this.specifiedByURL = config.specifiedByURL;
    this.serialize =
      (_config$serialize = config.serialize) !== null &&
      _config$serialize !== void 0
        ? _config$serialize
        : identityFunc;
    this.parseValue = parseValue;
    this.parseLiteral =
      (_config$parseLiteral = config.parseLiteral) !== null &&
      _config$parseLiteral !== void 0
        ? _config$parseLiteral
        : (node, variables) => parseValue(valueFromASTUntyped(node, variables));
    this.extensions = toObjMap(config.extensions);
    this.astNode = config.astNode;
    this.extensionASTNodes =
      (_config$extensionASTN = config.extensionASTNodes) !== null &&
      _config$extensionASTN !== void 0
        ? _config$extensionASTN
        : [];
    config.specifiedByURL == null ||
      typeof config.specifiedByURL === 'string' ||
      devAssert(
        false,
        `${this.name} must provide "specifiedByURL" as a string, ` +
          `but got: ${inspect(config.specifiedByURL)}.`,
      );
    config.serialize == null ||
      typeof config.serialize === 'function' ||
      devAssert(
        false,
        `${this.name} must provide "serialize" function. If this custom Scalar is also used as an input type, ensure "parseValue" and "parseLiteral" functions are also provided.`,
      );

    if (config.parseLiteral) {
      (typeof config.parseValue === 'function' &&
        typeof config.parseLiteral === 'function') ||
        devAssert(
          false,
          `${this.name} must provide both "parseValue" and "parseLiteral" functions.`,
        );
    }
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLScalarType';
  }

  toConfig() {
    return {
      name: this.name,
      description: this.description,
      specifiedByURL: this.specifiedByURL,
      serialize: this.serialize,
      parseValue: this.parseValue,
      parseLiteral: this.parseLiteral,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString() {
    return this.name;
  }

  toJSON() {
    return this.toString();
  }
}

/**
 * Object Type Definition
 *
 * Almost all of the GraphQL types you define will be object types. Object types
 * have a name, but most importantly describe their fields.
 *
 * Example:
 *
 * ```ts
 * const AddressType = new GraphQLObjectType({
 *   name: 'Address',
 *   fields: {
 *     street: { type: GraphQLString },
 *     number: { type: GraphQLInt },
 *     formatted: {
 *       type: GraphQLString,
 *       resolve(obj) {
 *         return obj.number + ' ' + obj.street
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * When two types need to refer to each other, or a type needs to refer to
 * itself in a field, you can use a function expression (aka a closure or a
 * thunk) to supply the fields lazily.
 *
 * Example:
 *
 * ```ts
 * const PersonType = new GraphQLObjectType({
 *   name: 'Person',
 *   fields: () => ({
 *     name: { type: GraphQLString },
 *     bestFriend: { type: PersonType },
 *   })
 * });
 * ```
 */
class GraphQLObjectType {
  constructor(config) {
    var _config$extensionASTN2;

    this.name = assertName(config.name);
    this.description = config.description;
    this.isTypeOf = config.isTypeOf;
    this.extensions = toObjMap(config.extensions);
    this.astNode = config.astNode;
    this.extensionASTNodes =
      (_config$extensionASTN2 = config.extensionASTNodes) !== null &&
      _config$extensionASTN2 !== void 0
        ? _config$extensionASTN2
        : [];

    this._fields = () => defineFieldMap(config);

    this._interfaces = () => defineInterfaces(config);

    config.isTypeOf == null ||
      typeof config.isTypeOf === 'function' ||
      devAssert(
        false,
        `${this.name} must provide "isTypeOf" as a function, ` +
          `but got: ${inspect(config.isTypeOf)}.`,
      );
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLObjectType';
  }

  getFields() {
    if (typeof this._fields === 'function') {
      this._fields = this._fields();
    }

    return this._fields;
  }

  getInterfaces() {
    if (typeof this._interfaces === 'function') {
      this._interfaces = this._interfaces();
    }

    return this._interfaces;
  }

  toConfig() {
    return {
      name: this.name,
      description: this.description,
      interfaces: this.getInterfaces(),
      fields: fieldsToFieldsConfig(this.getFields()),
      isTypeOf: this.isTypeOf,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString() {
    return this.name;
  }

  toJSON() {
    return this.toString();
  }
}

function defineInterfaces(config) {
  var _config$interfaces;

  const interfaces = resolveReadonlyArrayThunk(
    (_config$interfaces = config.interfaces) !== null &&
      _config$interfaces !== void 0
      ? _config$interfaces
      : [],
  );
  Array.isArray(interfaces) ||
    devAssert(
      false,
      `${config.name} interfaces must be an Array or a function which returns an Array.`,
    );
  return interfaces;
}

function defineFieldMap(config) {
  const fieldMap = resolveObjMapThunk(config.fields);
  isPlainObj(fieldMap) ||
    devAssert(
      false,
      `${config.name} fields must be an object with field names as keys or a function which returns such an object.`,
    );
  return mapValue(fieldMap, (fieldConfig, fieldName) => {
    var _fieldConfig$args;

    isPlainObj(fieldConfig) ||
      devAssert(
        false,
        `${config.name}.${fieldName} field config must be an object.`,
      );
    fieldConfig.resolve == null ||
      typeof fieldConfig.resolve === 'function' ||
      devAssert(
        false,
        `${config.name}.${fieldName} field resolver must be a function if ` +
          `provided, but got: ${inspect(fieldConfig.resolve)}.`,
      );
    const argsConfig =
      (_fieldConfig$args = fieldConfig.args) !== null &&
      _fieldConfig$args !== void 0
        ? _fieldConfig$args
        : {};
    isPlainObj(argsConfig) ||
      devAssert(
        false,
        `${config.name}.${fieldName} args must be an object with argument names as keys.`,
      );
    return {
      name: assertName(fieldName),
      description: fieldConfig.description,
      type: fieldConfig.type,
      args: defineArguments(argsConfig),
      resolve: fieldConfig.resolve,
      subscribe: fieldConfig.subscribe,
      deprecationReason: fieldConfig.deprecationReason,
      extensions: toObjMap(fieldConfig.extensions),
      astNode: fieldConfig.astNode,
    };
  });
}

function defineArguments(config) {
  return Object.entries(config).map(([argName, argConfig]) => ({
    name: assertName(argName),
    description: argConfig.description,
    type: argConfig.type,
    defaultValue: argConfig.defaultValue,
    deprecationReason: argConfig.deprecationReason,
    extensions: toObjMap(argConfig.extensions),
    astNode: argConfig.astNode,
  }));
}

function isPlainObj(obj) {
  return isObjectLike(obj) && !Array.isArray(obj);
}

function fieldsToFieldsConfig(fields) {
  return mapValue(fields, (field) => ({
    description: field.description,
    type: field.type,
    args: argsToArgsConfig(field.args),
    resolve: field.resolve,
    subscribe: field.subscribe,
    deprecationReason: field.deprecationReason,
    extensions: field.extensions,
    astNode: field.astNode,
  }));
}
/**
 * @internal
 */

function argsToArgsConfig(args) {
  return keyValMap(
    args,
    (arg) => arg.name,
    (arg) => ({
      description: arg.description,
      type: arg.type,
      defaultValue: arg.defaultValue,
      deprecationReason: arg.deprecationReason,
      extensions: arg.extensions,
      astNode: arg.astNode,
    }),
  );
}

/**
 * Interface Type Definition
 *
 * When a field can return one of a heterogeneous set of types, a Interface type
 * is used to describe what types are possible, what fields are in common across
 * all types, as well as a function to determine which type is actually used
 * when the field is resolved.
 *
 * Example:
 *
 * ```ts
 * const EntityType = new GraphQLInterfaceType({
 *   name: 'Entity',
 *   fields: {
 *     name: { type: GraphQLString }
 *   }
 * });
 * ```
 */
class GraphQLInterfaceType {
  constructor(config) {
    var _config$extensionASTN3;

    this.name = assertName(config.name);
    this.description = config.description;
    this.resolveType = config.resolveType;
    this.extensions = toObjMap(config.extensions);
    this.astNode = config.astNode;
    this.extensionASTNodes =
      (_config$extensionASTN3 = config.extensionASTNodes) !== null &&
      _config$extensionASTN3 !== void 0
        ? _config$extensionASTN3
        : [];
    this._fields = defineFieldMap.bind(undefined, config);
    this._interfaces = defineInterfaces.bind(undefined, config);
    config.resolveType == null ||
      typeof config.resolveType === 'function' ||
      devAssert(
        false,
        `${this.name} must provide "resolveType" as a function, ` +
          `but got: ${inspect(config.resolveType)}.`,
      );
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLInterfaceType';
  }

  getFields() {
    if (typeof this._fields === 'function') {
      this._fields = this._fields();
    }

    return this._fields;
  }

  getInterfaces() {
    if (typeof this._interfaces === 'function') {
      this._interfaces = this._interfaces();
    }

    return this._interfaces;
  }

  toConfig() {
    return {
      name: this.name,
      description: this.description,
      interfaces: this.getInterfaces(),
      fields: fieldsToFieldsConfig(this.getFields()),
      resolveType: this.resolveType,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString() {
    return this.name;
  }

  toJSON() {
    return this.toString();
  }
}

/**
 * Union Type Definition
 *
 * When a field can return one of a heterogeneous set of types, a Union type
 * is used to describe what types are possible as well as providing a function
 * to determine which type is actually used when the field is resolved.
 *
 * Example:
 *
 * ```ts
 * const PetType = new GraphQLUnionType({
 *   name: 'Pet',
 *   types: [ DogType, CatType ],
 *   resolveType(value) {
 *     if (value instanceof Dog) {
 *       return DogType;
 *     }
 *     if (value instanceof Cat) {
 *       return CatType;
 *     }
 *   }
 * });
 * ```
 */
class GraphQLUnionType {
  constructor(config) {
    var _config$extensionASTN4;

    this.name = assertName(config.name);
    this.description = config.description;
    this.resolveType = config.resolveType;
    this.extensions = toObjMap(config.extensions);
    this.astNode = config.astNode;
    this.extensionASTNodes =
      (_config$extensionASTN4 = config.extensionASTNodes) !== null &&
      _config$extensionASTN4 !== void 0
        ? _config$extensionASTN4
        : [];
    this._types = defineTypes.bind(undefined, config);
    config.resolveType == null ||
      typeof config.resolveType === 'function' ||
      devAssert(
        false,
        `${this.name} must provide "resolveType" as a function, ` +
          `but got: ${inspect(config.resolveType)}.`,
      );
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLUnionType';
  }

  getTypes() {
    if (typeof this._types === 'function') {
      this._types = this._types();
    }

    return this._types;
  }

  toConfig() {
    return {
      name: this.name,
      description: this.description,
      types: this.getTypes(),
      resolveType: this.resolveType,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString() {
    return this.name;
  }

  toJSON() {
    return this.toString();
  }
}

function defineTypes(config) {
  const types = resolveReadonlyArrayThunk(config.types);
  Array.isArray(types) ||
    devAssert(
      false,
      `Must provide Array of types or a function which returns such an array for Union ${config.name}.`,
    );
  return types;
}

/**
 * Enum Type Definition
 *
 * Some leaf values of requests and input values are Enums. GraphQL serializes
 * Enum values as strings, however internally Enums can be represented by any
 * kind of type, often integers.
 *
 * Example:
 *
 * ```ts
 * const RGBType = new GraphQLEnumType({
 *   name: 'RGB',
 *   values: {
 *     RED: { value: 0 },
 *     GREEN: { value: 1 },
 *     BLUE: { value: 2 }
 *   }
 * });
 * ```
 *
 * Note: If a value is not provided in a definition, the name of the enum value
 * will be used as its internal value.
 */
class GraphQLEnumType {
  /* <T> */
  constructor(config) {
    var _config$extensionASTN5;

    this.name = assertName(config.name);
    this.description = config.description;
    this.extensions = toObjMap(config.extensions);
    this.astNode = config.astNode;
    this.extensionASTNodes =
      (_config$extensionASTN5 = config.extensionASTNodes) !== null &&
      _config$extensionASTN5 !== void 0
        ? _config$extensionASTN5
        : [];
    this._values = defineEnumValues(this.name, config.values);
    this._valueLookup = new Map(
      this._values.map((enumValue) => [enumValue.value, enumValue]),
    );
    this._nameLookup = keyMap(this._values, (value) => value.name);
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLEnumType';
  }

  getValues() {
    return this._values;
  }

  getValue(name) {
    return this._nameLookup[name];
  }

  serialize(outputValue) {
    const enumValue = this._valueLookup.get(outputValue);

    if (enumValue === undefined) {
      throw new GraphQLError(
        `Enum "${this.name}" cannot represent value: ${inspect(outputValue)}`,
      );
    }

    return enumValue.name;
  }

  parseValue(inputValue) /* T */
  {
    if (typeof inputValue !== 'string') {
      const valueStr = inspect(inputValue);
      throw new GraphQLError(
        `Enum "${this.name}" cannot represent non-string value: ${valueStr}.` +
          didYouMeanEnumValue(this, valueStr),
      );
    }

    const enumValue = this.getValue(inputValue);

    if (enumValue == null) {
      throw new GraphQLError(
        `Value "${inputValue}" does not exist in "${this.name}" enum.` +
          didYouMeanEnumValue(this, inputValue),
      );
    }

    return enumValue.value;
  }

  parseLiteral(valueNode, _variables) /* T */
  {
    // Note: variables will be resolved to a value before calling this function.
    if (valueNode.kind !== Kind.ENUM) {
      const valueStr = print(valueNode);
      throw new GraphQLError(
        `Enum "${this.name}" cannot represent non-enum value: ${valueStr}.` +
          didYouMeanEnumValue(this, valueStr),
        {
          nodes: valueNode,
        },
      );
    }

    const enumValue = this.getValue(valueNode.value);

    if (enumValue == null) {
      const valueStr = print(valueNode);
      throw new GraphQLError(
        `Value "${valueStr}" does not exist in "${this.name}" enum.` +
          didYouMeanEnumValue(this, valueStr),
        {
          nodes: valueNode,
        },
      );
    }

    return enumValue.value;
  }

  toConfig() {
    const values = keyValMap(
      this.getValues(),
      (value) => value.name,
      (value) => ({
        description: value.description,
        value: value.value,
        deprecationReason: value.deprecationReason,
        extensions: value.extensions,
        astNode: value.astNode,
      }),
    );
    return {
      name: this.name,
      description: this.description,
      values,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString() {
    return this.name;
  }

  toJSON() {
    return this.toString();
  }
}

function didYouMeanEnumValue(enumType, unknownValueStr) {
  const allNames = enumType.getValues().map((value) => value.name);
  const suggestedValues = suggestionList(unknownValueStr, allNames);
  return didYouMean('the enum value', suggestedValues);
}

function defineEnumValues(typeName, valueMap) {
  isPlainObj(valueMap) ||
    devAssert(
      false,
      `${typeName} values must be an object with value names as keys.`,
    );
  return Object.entries(valueMap).map(([valueName, valueConfig]) => {
    isPlainObj(valueConfig) ||
      devAssert(
        false,
        `${typeName}.${valueName} must refer to an object with a "value" key ` +
          `representing an internal value but got: ${inspect(valueConfig)}.`,
      );
    return {
      name: assertEnumValueName(valueName),
      description: valueConfig.description,
      value: valueConfig.value !== undefined ? valueConfig.value : valueName,
      deprecationReason: valueConfig.deprecationReason,
      extensions: toObjMap(valueConfig.extensions),
      astNode: valueConfig.astNode,
    };
  });
}

/**
 * Input Object Type Definition
 *
 * An input object defines a structured collection of fields which may be
 * supplied to a field argument.
 *
 * Using `NonNull` will ensure that a value must be provided by the query
 *
 * Example:
 *
 * ```ts
 * const GeoPoint = new GraphQLInputObjectType({
 *   name: 'GeoPoint',
 *   fields: {
 *     lat: { type: new GraphQLNonNull(GraphQLFloat) },
 *     lon: { type: new GraphQLNonNull(GraphQLFloat) },
 *     alt: { type: GraphQLFloat, defaultValue: 0 },
 *   }
 * });
 * ```
 */
class GraphQLInputObjectType {
  constructor(config) {
    var _config$extensionASTN6;

    this.name = assertName(config.name);
    this.description = config.description;
    this.extensions = toObjMap(config.extensions);
    this.astNode = config.astNode;
    this.extensionASTNodes =
      (_config$extensionASTN6 = config.extensionASTNodes) !== null &&
      _config$extensionASTN6 !== void 0
        ? _config$extensionASTN6
        : [];
    this._fields = defineInputFieldMap.bind(undefined, config);
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLInputObjectType';
  }

  getFields() {
    if (typeof this._fields === 'function') {
      this._fields = this._fields();
    }

    return this._fields;
  }

  toConfig() {
    const fields = mapValue(this.getFields(), (field) => ({
      description: field.description,
      type: field.type,
      defaultValue: field.defaultValue,
      deprecationReason: field.deprecationReason,
      extensions: field.extensions,
      astNode: field.astNode,
    }));
    return {
      name: this.name,
      description: this.description,
      fields,
      extensions: this.extensions,
      astNode: this.astNode,
      extensionASTNodes: this.extensionASTNodes,
    };
  }

  toString() {
    return this.name;
  }

  toJSON() {
    return this.toString();
  }
}

function defineInputFieldMap(config) {
  const fieldMap = resolveObjMapThunk(config.fields);
  isPlainObj(fieldMap) ||
    devAssert(
      false,
      `${config.name} fields must be an object with field names as keys or a function which returns such an object.`,
    );
  return mapValue(fieldMap, (fieldConfig, fieldName) => {
    !('resolve' in fieldConfig) ||
      devAssert(
        false,
        `${config.name}.${fieldName} field has a resolve property, but Input Types cannot define resolvers.`,
      );
    return {
      name: assertName(fieldName),
      description: fieldConfig.description,
      type: fieldConfig.type,
      defaultValue: fieldConfig.defaultValue,
      deprecationReason: fieldConfig.deprecationReason,
      extensions: toObjMap(fieldConfig.extensions),
      astNode: fieldConfig.astNode,
    };
  });
}

/**
 * The set of allowed directive location values.
 */
var DirectiveLocation;

(function (DirectiveLocation) {
  DirectiveLocation['QUERY'] = 'QUERY';
  DirectiveLocation['MUTATION'] = 'MUTATION';
  DirectiveLocation['SUBSCRIPTION'] = 'SUBSCRIPTION';
  DirectiveLocation['FIELD'] = 'FIELD';
  DirectiveLocation['FRAGMENT_DEFINITION'] = 'FRAGMENT_DEFINITION';
  DirectiveLocation['FRAGMENT_SPREAD'] = 'FRAGMENT_SPREAD';
  DirectiveLocation['INLINE_FRAGMENT'] = 'INLINE_FRAGMENT';
  DirectiveLocation['VARIABLE_DEFINITION'] = 'VARIABLE_DEFINITION';
  DirectiveLocation['SCHEMA'] = 'SCHEMA';
  DirectiveLocation['SCALAR'] = 'SCALAR';
  DirectiveLocation['OBJECT'] = 'OBJECT';
  DirectiveLocation['FIELD_DEFINITION'] = 'FIELD_DEFINITION';
  DirectiveLocation['ARGUMENT_DEFINITION'] = 'ARGUMENT_DEFINITION';
  DirectiveLocation['INTERFACE'] = 'INTERFACE';
  DirectiveLocation['UNION'] = 'UNION';
  DirectiveLocation['ENUM'] = 'ENUM';
  DirectiveLocation['ENUM_VALUE'] = 'ENUM_VALUE';
  DirectiveLocation['INPUT_OBJECT'] = 'INPUT_OBJECT';
  DirectiveLocation['INPUT_FIELD_DEFINITION'] = 'INPUT_FIELD_DEFINITION';
})(DirectiveLocation || (DirectiveLocation = {}));
/**
 * The enum type representing the directive location values.
 *
 * @deprecated Please use `DirectiveLocation`. Will be remove in v17.
 */

/**
 * Maximum possible Int value as per GraphQL Spec (32-bit signed integer).
 * n.b. This differs from JavaScript's numbers that are IEEE 754 doubles safe up-to 2^53 - 1
 * */

const GRAPHQL_MAX_INT = 2147483647;
/**
 * Minimum possible Int value as per GraphQL Spec (32-bit signed integer).
 * n.b. This differs from JavaScript's numbers that are IEEE 754 doubles safe starting at -(2^53 - 1)
 * */

const GRAPHQL_MIN_INT = -2147483648;
new GraphQLScalarType({
  name: 'Int',
  description:
    'The `Int` scalar type represents non-fractional signed whole numeric values. Int can represent values between -(2^31) and 2^31 - 1.',

  serialize(outputValue) {
    const coercedValue = serializeObject(outputValue);

    if (typeof coercedValue === 'boolean') {
      return coercedValue ? 1 : 0;
    }

    let num = coercedValue;

    if (typeof coercedValue === 'string' && coercedValue !== '') {
      num = Number(coercedValue);
    }

    if (typeof num !== 'number' || !Number.isInteger(num)) {
      throw new GraphQLError(
        `Int cannot represent non-integer value: ${inspect(coercedValue)}`,
      );
    }

    if (num > GRAPHQL_MAX_INT || num < GRAPHQL_MIN_INT) {
      throw new GraphQLError(
        'Int cannot represent non 32-bit signed integer value: ' +
          inspect(coercedValue),
      );
    }

    return num;
  },

  parseValue(inputValue) {
    if (typeof inputValue !== 'number' || !Number.isInteger(inputValue)) {
      throw new GraphQLError(
        `Int cannot represent non-integer value: ${inspect(inputValue)}`,
      );
    }

    if (inputValue > GRAPHQL_MAX_INT || inputValue < GRAPHQL_MIN_INT) {
      throw new GraphQLError(
        `Int cannot represent non 32-bit signed integer value: ${inputValue}`,
      );
    }

    return inputValue;
  },

  parseLiteral(valueNode) {
    if (valueNode.kind !== Kind.INT) {
      throw new GraphQLError(
        `Int cannot represent non-integer value: ${print(valueNode)}`,
        {
          nodes: valueNode,
        },
      );
    }

    const num = parseInt(valueNode.value, 10);

    if (num > GRAPHQL_MAX_INT || num < GRAPHQL_MIN_INT) {
      throw new GraphQLError(
        `Int cannot represent non 32-bit signed integer value: ${valueNode.value}`,
        {
          nodes: valueNode,
        },
      );
    }

    return num;
  },
});
new GraphQLScalarType({
  name: 'Float',
  description:
    'The `Float` scalar type represents signed double-precision fractional values as specified by [IEEE 754](https://en.wikipedia.org/wiki/IEEE_floating_point).',

  serialize(outputValue) {
    const coercedValue = serializeObject(outputValue);

    if (typeof coercedValue === 'boolean') {
      return coercedValue ? 1 : 0;
    }

    let num = coercedValue;

    if (typeof coercedValue === 'string' && coercedValue !== '') {
      num = Number(coercedValue);
    }

    if (typeof num !== 'number' || !Number.isFinite(num)) {
      throw new GraphQLError(
        `Float cannot represent non numeric value: ${inspect(coercedValue)}`,
      );
    }

    return num;
  },

  parseValue(inputValue) {
    if (typeof inputValue !== 'number' || !Number.isFinite(inputValue)) {
      throw new GraphQLError(
        `Float cannot represent non numeric value: ${inspect(inputValue)}`,
      );
    }

    return inputValue;
  },

  parseLiteral(valueNode) {
    if (valueNode.kind !== Kind.FLOAT && valueNode.kind !== Kind.INT) {
      throw new GraphQLError(
        `Float cannot represent non numeric value: ${print(valueNode)}`,
        valueNode,
      );
    }

    return parseFloat(valueNode.value);
  },
});
const GraphQLString = new GraphQLScalarType({
  name: 'String',
  description:
    'The `String` scalar type represents textual data, represented as UTF-8 character sequences. The String type is most often used by GraphQL to represent free-form human-readable text.',

  serialize(outputValue) {
    const coercedValue = serializeObject(outputValue); // Serialize string, boolean and number values to a string, but do not
    // attempt to coerce object, function, symbol, or other types as strings.

    if (typeof coercedValue === 'string') {
      return coercedValue;
    }

    if (typeof coercedValue === 'boolean') {
      return coercedValue ? 'true' : 'false';
    }

    if (typeof coercedValue === 'number' && Number.isFinite(coercedValue)) {
      return coercedValue.toString();
    }

    throw new GraphQLError(
      `String cannot represent value: ${inspect(outputValue)}`,
    );
  },

  parseValue(inputValue) {
    if (typeof inputValue !== 'string') {
      throw new GraphQLError(
        `String cannot represent a non string value: ${inspect(inputValue)}`,
      );
    }

    return inputValue;
  },

  parseLiteral(valueNode) {
    if (valueNode.kind !== Kind.STRING) {
      throw new GraphQLError(
        `String cannot represent a non string value: ${print(valueNode)}`,
        {
          nodes: valueNode,
        },
      );
    }

    return valueNode.value;
  },
});
const GraphQLBoolean = new GraphQLScalarType({
  name: 'Boolean',
  description: 'The `Boolean` scalar type represents `true` or `false`.',

  serialize(outputValue) {
    const coercedValue = serializeObject(outputValue);

    if (typeof coercedValue === 'boolean') {
      return coercedValue;
    }

    if (Number.isFinite(coercedValue)) {
      return coercedValue !== 0;
    }

    throw new GraphQLError(
      `Boolean cannot represent a non boolean value: ${inspect(coercedValue)}`,
    );
  },

  parseValue(inputValue) {
    if (typeof inputValue !== 'boolean') {
      throw new GraphQLError(
        `Boolean cannot represent a non boolean value: ${inspect(inputValue)}`,
      );
    }

    return inputValue;
  },

  parseLiteral(valueNode) {
    if (valueNode.kind !== Kind.BOOLEAN) {
      throw new GraphQLError(
        `Boolean cannot represent a non boolean value: ${print(valueNode)}`,
        {
          nodes: valueNode,
        },
      );
    }

    return valueNode.value;
  },
});
new GraphQLScalarType({
  name: 'ID',
  description:
    'The `ID` scalar type represents a unique identifier, often used to refetch an object or as key for a cache. The ID type appears in a JSON response as a String; however, it is not intended to be human-readable. When expected as an input type, any string (such as `"4"`) or integer (such as `4`) input value will be accepted as an ID.',

  serialize(outputValue) {
    const coercedValue = serializeObject(outputValue);

    if (typeof coercedValue === 'string') {
      return coercedValue;
    }

    if (Number.isInteger(coercedValue)) {
      return String(coercedValue);
    }

    throw new GraphQLError(
      `ID cannot represent value: ${inspect(outputValue)}`,
    );
  },

  parseValue(inputValue) {
    if (typeof inputValue === 'string') {
      return inputValue;
    }

    if (typeof inputValue === 'number' && Number.isInteger(inputValue)) {
      return inputValue.toString();
    }

    throw new GraphQLError(`ID cannot represent value: ${inspect(inputValue)}`);
  },

  parseLiteral(valueNode) {
    if (valueNode.kind !== Kind.STRING && valueNode.kind !== Kind.INT) {
      throw new GraphQLError(
        'ID cannot represent a non-string and non-integer value: ' +
          print(valueNode),
        {
          nodes: valueNode,
        },
      );
    }

    return valueNode.value;
  },
});
// a common way to represent a complex value which can be represented as
// a string (ex: MongoDB id objects).

function serializeObject(outputValue) {
  if (isObjectLike(outputValue)) {
    if (typeof outputValue.valueOf === 'function') {
      const valueOfResult = outputValue.valueOf();

      if (!isObjectLike(valueOfResult)) {
        return valueOfResult;
      }
    }

    if (typeof outputValue.toJSON === 'function') {
      return outputValue.toJSON();
    }
  }

  return outputValue;
}

/**
 * Custom extensions
 *
 * @remarks
 * Use a unique identifier name for your extension, for example the name of
 * your library or project. Do not use a shortened identifier as this increases
 * the risk of conflicts. We recommend you add at most one extension field,
 * an object which can contain all the values you need.
 */

/**
 * Directives are used by the GraphQL runtime as a way of modifying execution
 * behavior. Type system creators will usually not create these directly.
 */
class GraphQLDirective {
  constructor(config) {
    var _config$isRepeatable, _config$args;

    this.name = assertName(config.name);
    this.description = config.description;
    this.locations = config.locations;
    this.isRepeatable =
      (_config$isRepeatable = config.isRepeatable) !== null &&
      _config$isRepeatable !== void 0
        ? _config$isRepeatable
        : false;
    this.extensions = toObjMap(config.extensions);
    this.astNode = config.astNode;
    Array.isArray(config.locations) ||
      devAssert(false, `@${config.name} locations must be an Array.`);
    const args =
      (_config$args = config.args) !== null && _config$args !== void 0
        ? _config$args
        : {};
    (isObjectLike(args) && !Array.isArray(args)) ||
      devAssert(
        false,
        `@${config.name} args must be an object with argument names as keys.`,
      );
    this.args = defineArguments(args);
  }

  get [Symbol.toStringTag]() {
    return 'GraphQLDirective';
  }

  toConfig() {
    return {
      name: this.name,
      description: this.description,
      locations: this.locations,
      args: argsToArgsConfig(this.args),
      isRepeatable: this.isRepeatable,
      extensions: this.extensions,
      astNode: this.astNode,
    };
  }

  toString() {
    return '@' + this.name;
  }

  toJSON() {
    return this.toString();
  }
}

/**
 * Used to conditionally include fields or fragments.
 */
const GraphQLIncludeDirective = new GraphQLDirective({
  name: 'include',
  description:
    'Directs the executor to include this field or fragment only when the `if` argument is true.',
  locations: [
    DirectiveLocation.FIELD,
    DirectiveLocation.FRAGMENT_SPREAD,
    DirectiveLocation.INLINE_FRAGMENT,
  ],
  args: {
    if: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Included when true.',
    },
  },
});
/**
 * Used to conditionally skip (exclude) fields or fragments.
 */

const GraphQLSkipDirective = new GraphQLDirective({
  name: 'skip',
  description:
    'Directs the executor to skip this field or fragment when the `if` argument is true.',
  locations: [
    DirectiveLocation.FIELD,
    DirectiveLocation.FRAGMENT_SPREAD,
    DirectiveLocation.INLINE_FRAGMENT,
  ],
  args: {
    if: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Skipped when true.',
    },
  },
});
/**
 * Constant string used for default reason for a deprecation.
 */

const DEFAULT_DEPRECATION_REASON = 'No longer supported';
/**
 * Used to declare element of a GraphQL schema as deprecated.
 */

new GraphQLDirective({
  name: 'deprecated',
  description: 'Marks an element of a GraphQL schema as no longer supported.',
  locations: [
    DirectiveLocation.FIELD_DEFINITION,
    DirectiveLocation.ARGUMENT_DEFINITION,
    DirectiveLocation.INPUT_FIELD_DEFINITION,
    DirectiveLocation.ENUM_VALUE,
  ],
  args: {
    reason: {
      type: GraphQLString,
      description:
        'Explains why this element was deprecated, usually also including a suggestion for how to access supported similar data. Formatted using the Markdown syntax, as specified by [CommonMark](https://commonmark.org/).',
      defaultValue: DEFAULT_DEPRECATION_REASON,
    },
  },
});
/**
 * Used to provide a URL for specifying the behavior of custom scalar definitions.
 */

new GraphQLDirective({
  name: 'specifiedBy',
  description: 'Exposes a URL that specifies the behavior of this scalar.',
  locations: [DirectiveLocation.SCALAR],
  args: {
    url: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The URL that specifies the behavior of this scalar.',
    },
  },
});

function typeFromAST(schema, typeNode) {
  switch (typeNode.kind) {
    case Kind.LIST_TYPE: {
      const innerType = typeFromAST(schema, typeNode.type);
      return innerType && new GraphQLList(innerType);
    }

    case Kind.NON_NULL_TYPE: {
      const innerType = typeFromAST(schema, typeNode.type);
      return innerType && new GraphQLNonNull(innerType);
    }

    case Kind.NAMED_TYPE:
      return schema.getType(typeNode.name.value);
  }
}

/**
 * Given a Path and a key, return a new Path containing the new key.
 */
function addPath(prev, key, typename) {
  return {
    prev,
    key,
    typename,
  };
}

/**
 * Produces a JavaScript value given a GraphQL Value AST.
 *
 * A GraphQL type must be provided, which will be used to interpret different
 * GraphQL Value literals.
 *
 * Returns `undefined` when the value could not be validly coerced according to
 * the provided type.
 *
 * | GraphQL Value        | JSON Value    |
 * | -------------------- | ------------- |
 * | Input Object         | Object        |
 * | List                 | Array         |
 * | Boolean              | Boolean       |
 * | String               | String        |
 * | Int / Float          | Number        |
 * | Enum Value           | Unknown       |
 * | NullValue            | null          |
 *
 */

function valueFromAST(valueNode, type, variables) {
  if (!valueNode) {
    // When there is no node, then there is also no value.
    // Importantly, this is different from returning the value null.
    return;
  }

  if (valueNode.kind === Kind.VARIABLE) {
    const variableName = valueNode.name.value;

    if (variables == null || variables[variableName] === undefined) {
      // No valid return value.
      return;
    }

    const variableValue = variables[variableName];

    if (variableValue === null && isNonNullType(type)) {
      return; // Invalid: intentionally return no value.
    } // Note: This does no further checking that this variable is correct.
    // This assumes that this query has been validated and the variable
    // usage here is of the correct type.

    return variableValue;
  }

  if (isNonNullType(type)) {
    if (valueNode.kind === Kind.NULL) {
      return; // Invalid: intentionally return no value.
    }

    return valueFromAST(valueNode, type.ofType, variables);
  }

  if (valueNode.kind === Kind.NULL) {
    // This is explicitly returning the value null.
    return null;
  }

  if (isListType(type)) {
    const itemType = type.ofType;

    if (valueNode.kind === Kind.LIST) {
      const coercedValues = [];

      for (const itemNode of valueNode.values) {
        if (isMissingVariable(itemNode, variables)) {
          // If an array contains a missing variable, it is either coerced to
          // null or if the item type is non-null, it considered invalid.
          if (isNonNullType(itemType)) {
            return; // Invalid: intentionally return no value.
          }

          coercedValues.push(null);
        } else {
          const itemValue = valueFromAST(itemNode, itemType, variables);

          if (itemValue === undefined) {
            return; // Invalid: intentionally return no value.
          }

          coercedValues.push(itemValue);
        }
      }

      return coercedValues;
    }

    const coercedValue = valueFromAST(valueNode, itemType, variables);

    if (coercedValue === undefined) {
      return; // Invalid: intentionally return no value.
    }

    return [coercedValue];
  }

  if (isInputObjectType(type)) {
    if (valueNode.kind !== Kind.OBJECT) {
      return; // Invalid: intentionally return no value.
    }

    const coercedObj = Object.create(null);
    const fieldNodes = keyMap(valueNode.fields, (field) => field.name.value);

    for (const field of Object.values(type.getFields())) {
      const fieldNode = fieldNodes[field.name];

      if (!fieldNode || isMissingVariable(fieldNode.value, variables)) {
        if (field.defaultValue !== undefined) {
          coercedObj[field.name] = field.defaultValue;
        } else if (isNonNullType(field.type)) {
          return; // Invalid: intentionally return no value.
        }

        continue;
      }

      const fieldValue = valueFromAST(fieldNode.value, field.type, variables);

      if (fieldValue === undefined) {
        return; // Invalid: intentionally return no value.
      }

      coercedObj[field.name] = fieldValue;
    }

    return coercedObj;
  }

  if (isLeafType(type)) {
    // Scalars and Enums fulfill parsing a literal value via parseLiteral().
    // Invalid values represent a failure to parse correctly, in which case
    // no value is returned.
    let result;

    try {
      result = type.parseLiteral(valueNode, variables);
    } catch (_error) {
      return; // Invalid: intentionally return no value.
    }

    if (result === undefined) {
      return; // Invalid: intentionally return no value.
    }

    return result;
  }
  /* c8 ignore next 3 */
  // Not reachable, all possible input types have been considered.

  invariant(false, 'Unexpected input type: ' + inspect(type));
} // Returns true if the provided valueNode is a variable which is not defined
// in the set of variables.

function isMissingVariable(valueNode, variables) {
  return (
    valueNode.kind === Kind.VARIABLE &&
    (variables == null || variables[valueNode.name.value] === undefined)
  );
}

/**
 * Prepares an object map of argument values given a list of argument
 * definitions and list of argument AST nodes.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */

function getArgumentValues(def, node, variableValues) {
  var _node$arguments;

  const coercedValues = {}; // FIXME: https://github.com/graphql/graphql-js/issues/2203

  /* c8 ignore next */

  const argumentNodes =
    (_node$arguments = node.arguments) !== null && _node$arguments !== void 0
      ? _node$arguments
      : [];
  const argNodeMap = keyMap(argumentNodes, (arg) => arg.name.value);

  for (const argDef of def.args) {
    const name = argDef.name;
    const argType = argDef.type;
    const argumentNode = argNodeMap[name];

    if (!argumentNode) {
      if (argDef.defaultValue !== undefined) {
        coercedValues[name] = argDef.defaultValue;
      } else if (isNonNullType(argType)) {
        throw new GraphQLError(
          `Argument "${name}" of required type "${inspect(argType)}" ` +
            'was not provided.',
          {
            nodes: node,
          },
        );
      }

      continue;
    }

    const valueNode = argumentNode.value;
    let isNull = valueNode.kind === Kind.NULL;

    if (valueNode.kind === Kind.VARIABLE) {
      const variableName = valueNode.name.value;

      if (
        variableValues == null ||
        !hasOwnProperty(variableValues, variableName)
      ) {
        if (argDef.defaultValue !== undefined) {
          coercedValues[name] = argDef.defaultValue;
        } else if (isNonNullType(argType)) {
          throw new GraphQLError(
            `Argument "${name}" of required type "${inspect(argType)}" ` +
              `was provided the variable "$${variableName}" which was not provided a runtime value.`,
            {
              nodes: valueNode,
            },
          );
        }

        continue;
      }

      isNull = variableValues[variableName] == null;
    }

    if (isNull && isNonNullType(argType)) {
      throw new GraphQLError(
        `Argument "${name}" of non-null type "${inspect(argType)}" ` +
          'must not be null.',
        {
          nodes: valueNode,
        },
      );
    }

    const coercedValue = valueFromAST(valueNode, argType, variableValues);

    if (coercedValue === undefined) {
      // Note: ValuesOfCorrectTypeRule validation should catch this before
      // execution. This is a runtime check to ensure execution does not
      // continue with an invalid argument value.
      throw new GraphQLError(
        `Argument "${name}" has invalid value ${print(valueNode)}.`,
        {
          nodes: valueNode,
        },
      );
    }

    coercedValues[name] = coercedValue;
  }

  return coercedValues;
}
/**
 * Prepares an object map of argument values given a directive definition
 * and a AST node which may contain directives. Optionally also accepts a map
 * of variable values.
 *
 * If the directive does not exist on the node, returns undefined.
 *
 * Note: The returned value is a plain Object with a prototype, since it is
 * exposed to user code. Care should be taken to not pull values from the
 * Object prototype.
 */

function getDirectiveValues(directiveDef, node, variableValues) {
  var _node$directives;

  const directiveNode =
    (_node$directives = node.directives) === null || _node$directives === void 0
      ? void 0
      : _node$directives.find(
          (directive) => directive.name.value === directiveDef.name,
        );

  if (directiveNode) {
    return getArgumentValues(directiveDef, directiveNode, variableValues);
  }
}

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

/**
 * Given a selectionSet, collects all of the fields and returns them.
 *
 * CollectFields requires the "runtime type" of an object. For a field that
 * returns an Interface or Union type, the "runtime type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */

function collectFields(
  schema,
  fragments,
  variableValues,
  runtimeType,
  selectionSet,
) {
  const fields = new Map();
  collectFieldsImpl(
    schema,
    fragments,
    variableValues,
    runtimeType,
    selectionSet,
    fields,
    new Set(),
  );
  return fields;
}

function collectFieldsImpl(
  schema,
  fragments,
  variableValues,
  runtimeType,
  selectionSet,
  fields,
  visitedFragmentNames,
) {
  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        if (!shouldIncludeNode(variableValues, selection)) {
          continue;
        }

        const name = getFieldEntryKey(selection);
        const fieldList = fields.get(name);

        if (fieldList !== undefined) {
          fieldList.push(selection);
        } else {
          fields.set(name, [selection]);
        }

        break;
      }

      case Kind.INLINE_FRAGMENT: {
        if (
          !shouldIncludeNode(variableValues, selection) ||
          !doesFragmentConditionMatch(schema, selection, runtimeType)
        ) {
          continue;
        }

        collectFieldsImpl(
          schema,
          fragments,
          variableValues,
          runtimeType,
          selection.selectionSet,
          fields,
          visitedFragmentNames,
        );
        break;
      }

      case Kind.FRAGMENT_SPREAD: {
        const fragName = selection.name.value;

        if (
          visitedFragmentNames.has(fragName) ||
          !shouldIncludeNode(variableValues, selection)
        ) {
          continue;
        }

        visitedFragmentNames.add(fragName);
        const fragment = fragments[fragName];

        if (
          !fragment ||
          !doesFragmentConditionMatch(schema, fragment, runtimeType)
        ) {
          continue;
        }

        collectFieldsImpl(
          schema,
          fragments,
          variableValues,
          runtimeType,
          fragment.selectionSet,
          fields,
          visitedFragmentNames,
        );
        break;
      }
    }
  }
}
/**
 * Determines if a field should be included based on the `@include` and `@skip`
 * directives, where `@skip` has higher precedence than `@include`.
 */

function shouldIncludeNode(variableValues, node) {
  const skip = getDirectiveValues(GraphQLSkipDirective, node, variableValues);

  if ((skip === null || skip === void 0 ? void 0 : skip.if) === true) {
    return false;
  }

  const include = getDirectiveValues(
    GraphQLIncludeDirective,
    node,
    variableValues,
  );

  if (
    (include === null || include === void 0 ? void 0 : include.if) === false
  ) {
    return false;
  }

  return true;
}
/**
 * Determines if a fragment is applicable to the given type.
 */

function doesFragmentConditionMatch(schema, fragment, type) {
  const typeConditionNode = fragment.typeCondition;

  if (!typeConditionNode) {
    return true;
  }

  const conditionalType = typeFromAST(schema, typeConditionNode);

  if (conditionalType === type) {
    return true;
  }

  if (isAbstractType(conditionalType)) {
    return schema.isSubType(conditionalType, type);
  }

  return false;
}
/**
 * Implements the logic to compute the key of a given field's entry
 */

function getFieldEntryKey(node) {
  return node.alias ? node.alias.value : node.name.value;
}

const getResolverAndArgs = ({ execContext }) => {
    // Taken from graphql-js executeSubscription - https://github.com/graphql/graphql-js/blob/main/src/execution/subscribe.ts#L187
    const { schema, fragments, operation, variableValues, contextValue } = execContext;
    const rootType = schema.getSubscriptionType();
    if (rootType == null) {
        throw new graphql.GraphQLError('Schema is not configured to execute subscription operation.', operation);
    }
    const rootFields = collectFields(schema, fragments, variableValues, rootType, operation.selectionSet);
    const [responseName, fieldNodes] = [...rootFields.entries()][0];
    const fieldDef = execute.getFieldDef(schema, rootType, fieldNodes[0]);
    if (!fieldDef) {
        const fieldName = fieldNodes[0].name.value;
        throw new graphql.GraphQLError(`The subscription field "${fieldName}" is not defined.`, fieldNodes);
    }
    const path = addPath(undefined, responseName, rootType.name);
    const info = execute.buildResolveInfo(execContext, fieldDef, fieldNodes, rootType, path);
    const args = values.getArgumentValues(fieldDef, fieldNodes[0], variableValues);
    return {
        field: fieldDef,
        root: null,
        args,
        context: contextValue,
        info,
    };
};

const isArray = (input) => Array.isArray(input);

/* eslint-disable @typescript-eslint/no-explicit-any */
const getFilteredSubs = async ({ server, event, excludeKeys = [] }) => {
    if (!event.payload || Object.keys(event.payload).length === 0) {
        server.log('getFilteredSubs', { event, excludeKeys });
        const iterator = server.models.subscription.query({
            IndexName: 'TopicIndex',
            ExpressionAttributeNames: { '#a': 'topic' },
            ExpressionAttributeValues: { ':1': event.topic },
            KeyConditionExpression: '#a = :1',
        });
        return await streamingIterables.collect(iterator);
    }
    const flattenPayload = collapseKeys(event.payload, excludeKeys);
    const filterExpressions = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};
    let attributeCounter = 0;
    for (const [key, value] of Object.entries(flattenPayload)) {
        const aliasNumber = attributeCounter++;
        expressionAttributeNames[`#${aliasNumber}`] = key;
        expressionAttributeValues[`:${aliasNumber}`] = value;
        filterExpressions.push(`(#filter.#${aliasNumber} = :${aliasNumber} OR attribute_not_exists(#filter.#${aliasNumber}))`);
    }
    server.log('getFilteredSubs', { event, excludeKeys, expressionAttributeNames, expressionAttributeValues, filterExpressions });
    const iterator = server.models.subscription.query({
        IndexName: 'TopicIndex',
        ExpressionAttributeNames: {
            '#hashKey': 'topic',
            '#filter': 'filter',
            ...expressionAttributeNames,
        },
        ExpressionAttributeValues: {
            ':hashKey': event.topic,
            ...expressionAttributeValues,
        },
        KeyConditionExpression: '#hashKey = :hashKey',
        FilterExpression: filterExpressions.join(' AND ') || undefined,
    });
    return await streamingIterables.collect(iterator);
};
const collapseKeys = (obj, excludeKeys = [], parent = []) => {
    const record = {};
    for (const [k1, v1] of Object.entries(obj)) {
        const path = [...parent, k1];
        const key = path.join('.');
        if (excludeKeys.includes(key)) {
            continue;
        }
        if (typeof v1 === 'string' || typeof v1 === 'number' || typeof v1 === 'boolean') {
            record[key] = v1;
            continue;
        }
        if (v1 && typeof v1 === 'object') {
            for (const [k2, v2] of Object.entries(collapseKeys(v1, excludeKeys, path))) {
                record[k2] = v2;
            }
            continue;
        }
    }
    return record;
};

const complete$1 = (serverPromise) => async (event, excludeKeys) => {
    const server = await serverPromise;
    const subscriptions = await getFilteredSubs({ server, event, excludeKeys });
    server.log('pubsub:complete', { event, subscriptions });
    const iters = subscriptions.map(async (sub) => {
        const message = {
            id: sub.subscriptionId,
            type: MessageType.Complete,
        };
        await postToConnection(server)({
            ...sub.requestContext,
            message,
        });
        await server.models.subscription.delete({ id: sub.id });
        const execContext = execute.buildExecutionContext({
            schema: server.schema,
            document: graphql.parse(sub.subscription.query),
            contextValue: await buildContext({ server, connectionInitPayload: sub.connectionInitPayload, connectionId: sub.connectionId }),
            variableValues: sub.subscription.variables,
            operationName: sub.subscription.operationName,
        });
        if (isArray(execContext)) {
            throw new AggregateError(execContext);
        }
        const { field, root, args, context, info } = getResolverAndArgs({ execContext });
        const onComplete = field?.subscribe?.onComplete;
        server.log('pubsub:complete:onComplete', { onComplete: !!onComplete });
        await onComplete?.(root, args, context, info);
    });
    await Promise.all(iters);
};

/* eslint-disable @typescript-eslint/ban-types */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildContext = ({ server, connectionInitPayload, connectionId }) => {
    const publish$1 = publish(server);
    const complete = complete$1(server);
    if (typeof server.context === 'function') {
        return server.context({ connectionInitPayload, connectionId, publish: publish$1, complete });
    }
    return { ...server.context, connectionInitPayload, connectionId, publish: publish$1, complete };
};

const publish = (serverPromise) => async (event, excludeKeys) => {
    const server = await serverPromise;
    server.log('pubsub:publish', { event, excludeKeys });
    const subscriptions = await getFilteredSubs({ server, event, excludeKeys });
    server.log('pubsub:publish', { subscriptions: subscriptions.map(({ connectionId, filter, subscription }) => ({ connectionId, filter, subscription })) });
    const iters = subscriptions.map(async (sub) => {
        const payload = await graphql.execute({
            schema: server.schema,
            document: graphql.parse(sub.subscription.query),
            rootValue: event,
            contextValue: await buildContext({ server, connectionInitPayload: sub.connectionInitPayload, connectionId: sub.connectionId }),
            variableValues: sub.subscription.variables,
            operationName: sub.subscription.operationName,
        });
        const message = {
            id: sub.subscriptionId,
            type: MessageType.Next,
            payload,
        };
        await postToConnection(server)({
            ...sub.requestContext,
            message,
        });
    });
    await Promise.all(iters);
};

/** Handler function for 'disconnect' message. */
const disconnect = async ({ server, event }) => {
    const { connectionId } = event.requestContext;
    server.log('messages:disconnect', { connectionId });
    try {
        await server.onDisconnect?.({ event });
        const topicSubscriptions = await streamingIterables.collect(server.models.subscription.query({
            IndexName: 'ConnectionIndex',
            ExpressionAttributeNames: { '#a': 'connectionId' },
            ExpressionAttributeValues: { ':1': connectionId },
            KeyConditionExpression: '#a = :1',
        }));
        const deletions = topicSubscriptions.map(async (sub) => {
            const queryContext = await buildContext({ server, connectionInitPayload: sub.connectionInitPayload, connectionId });
            const execContext = execute.buildExecutionContext({
                schema: server.schema,
                document: graphql.parse(sub.subscription.query),
                contextValue: queryContext,
                variableValues: sub.subscription.variables,
                operationName: sub.subscription.operationName,
            });
            if (isArray(execContext)) {
                throw new AggregateError(execContext);
            }
            const { field, root, args, context, info } = getResolverAndArgs({ execContext });
            const onComplete = field?.subscribe?.onComplete;
            server.log('messages:disconnect:onComplete', { onComplete: !!onComplete });
            await onComplete?.(root, args, context, info);
            await server.models.subscription.delete({ id: sub.id });
        });
        // do this first so that we don't create any more subscriptions for this connection
        await server.models.connection.delete({ id: connectionId });
        await Promise.all(deletions);
    }
    catch (err) {
        server.log('messages:disconnect:onError', { err, event });
        await server.onError?.(err, { event });
    }
};

const deleteConnection = (server) => async ({ connectionId: ConnectionId, domainName, stage, }) => {
    server.log('deleteConnection', { connectionId: ConnectionId });
    const api = server.apiGatewayManagementApi ??
        new awsSdk.ApiGatewayManagementApi({
            apiVersion: 'latest',
            endpoint: `${domainName}/${stage}`,
        });
    await api.deleteConnection({ ConnectionId }).promise();
};

/** Handler function for 'ping' message. */
const ping = async ({ server, event, message }) => {
    try {
        await server.onPing?.({ event, message });
        return postToConnection(server)({
            ...event.requestContext,
            message: { type: MessageType.Pong },
        });
    }
    catch (err) {
        await server.onError?.(err, { event, message });
        await deleteConnection(server)(event.requestContext);
    }
};

/** Handler function for 'complete' message. */
const complete = async ({ server, event, message }) => {
    server.log('messages:complete', { connectionId: event.requestContext.connectionId });
    try {
        const subscription = await server.models.subscription.get({ id: `${event.requestContext.connectionId}|${message.id}` });
        if (!subscription) {
            return;
        }
        const execContext = execute.buildExecutionContext({
            schema: server.schema,
            document: graphql.parse(subscription.subscription.query),
            contextValue: await buildContext({ server, connectionInitPayload: subscription.connectionInitPayload, connectionId: subscription.connectionId }),
            variableValues: subscription.subscription.variables,
            operationName: subscription.subscription.operationName,
        });
        if (isArray(execContext)) {
            throw new AggregateError(execContext);
        }
        const { field, root, args, context, info } = getResolverAndArgs({ execContext });
        const onComplete = field?.subscribe?.onComplete;
        server.log('messages:complete:onComplete', { onComplete: !!onComplete });
        await onComplete?.(root, args, context, info);
        await server.models.subscription.delete({ id: subscription.id });
    }
    catch (err) {
        server.log('messages:complete:onError', { err, event });
        await server.onError?.(err, { event, message });
        await deleteConnection(server)(event.requestContext);
    }
};

/** Handler function for 'subscribe' message. */
const subscribe$1 = async ({ server, event, message }) => {
    try {
        await setupSubscription({ server, event, message });
    }
    catch (err) {
        server.log('subscribe:error', { connectionId: event.requestContext.connectionId, error: err.message });
        await server.onError?.(err, { event, message });
        await deleteConnection(server)(event.requestContext);
    }
};
const setupSubscription = async ({ server, event, message }) => {
    const connectionId = event.requestContext.connectionId;
    server.log('subscribe', { connectionId, messageId: message.id, query: message.payload.query });
    const connection = await server.models.connection.get({ id: connectionId });
    if (!connection) {
        throw new Error('missing subscription record');
    }
    // Check for variable errors
    const errors = validateMessage(server)(message);
    if (errors) {
        server.log('subscribe:validateError', errors);
        return postToConnection(server)({
            ...event.requestContext,
            message: {
                type: MessageType.Error,
                id: message.id,
                payload: errors,
            },
        });
    }
    const contextValue = await buildContext({ server, connectionInitPayload: connection.payload, connectionId });
    const execContext = execute.buildExecutionContext({
        schema: server.schema,
        document: graphql.parse(message.payload.query),
        contextValue,
        variableValues: message.payload.variables,
        operationName: message.payload.operationName,
    });
    if (isArray(execContext)) {
        return postToConnection(server)({
            ...event.requestContext,
            message: {
                type: MessageType.Error,
                id: message.id,
                payload: execContext,
            },
        });
    }
    const subscriptionId = `${connection.id}|${message.id}`;
    if (await server.models.subscription.get({ id: subscriptionId })) {
        throw new Error(`Subscriber for ${message.id} already exists`);
    }
    if (execContext.operation.operation !== 'subscription') {
        await executeQuery(server, message, contextValue, event);
        return;
    }
    const { field, root, args, context, info } = getResolverAndArgs({ execContext });
    if (!field) {
        throw new Error('No field');
    }
    const { topic, filter, onSubscribe, onAfterSubscribe } = field.subscribe;
    server.log('onSubscribe', { onSubscribe: !!onSubscribe });
    const onSubscribeErrors = await onSubscribe?.(root, args, context, info);
    if (onSubscribeErrors) {
        server.log('onSubscribe', { onSubscribeErrors });
        return postToConnection(server)({
            ...event.requestContext,
            message: {
                type: MessageType.Error,
                id: message.id,
                payload: onSubscribeErrors,
            },
        });
    }
    const filterData = typeof filter === 'function' ? await filter(root, args, context, info) : filter;
    const subscription = {
        id: subscriptionId,
        topic,
        filter: filterData || {},
        subscriptionId: message.id,
        subscription: message.payload,
        connectionId: connection.id,
        connectionInitPayload: connection.payload,
        requestContext: event.requestContext,
        ttl: connection.ttl,
        createdAt: Date.now(),
    };
    server.log('subscribe:putSubscription', subscription);
    try {
        await server.models.subscription.put(subscription, {
            ConditionExpression: '#id <> :id',
            ExpressionAttributeNames: {
                '#id': 'id',
            },
            ExpressionAttributeValues: {
                ':id': subscriptionId,
            },
        });
    }
    catch (error) {
        if (error.code === 'ConditionalCheckFailedException') {
            throw new Error(`Subscriber for ${message.id} already exists`);
        }
        throw error;
    }
    server.log('onAfterSubscribe', { onAfterSubscribe: !!onAfterSubscribe });
    await onAfterSubscribe?.(root, args, context, info);
};
/** Validate incoming query and arguments */
const validateMessage = (server) => (message) => {
    const errors = graphql.validate(server.schema, graphql.parse(message.payload.query));
    if (errors && errors.length > 0) {
        return errors;
    }
    try {
        execute.assertValidExecutionArguments(server.schema, graphql.parse(message.payload.query), message.payload.variables);
    }
    catch (err) {
        return [err];
    }
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeQuery(server, message, contextValue, event) {
    server.log('executeQuery', { connectionId: event.requestContext.connectionId, query: message.payload.query });
    const result = await execute.execute({
        schema: server.schema,
        document: graphql.parse(message.payload.query),
        contextValue,
        variableValues: message.payload.variables,
        operationName: message.payload.operationName,
    });
    await postToConnection(server)({
        ...event.requestContext,
        message: {
            type: MessageType.Next,
            id: message.id,
            payload: result,
        },
    });
    await postToConnection(server)({
        ...event.requestContext,
        message: {
            type: MessageType.Complete,
            id: message.id,
        },
    });
}

/**
 * Three hours from now
 */
const defaultTTL = (hours = 3) => Math.floor(Date.now() / 1000) + (hours * 60 * 60);

/** Handler function for 'connection_init' message. */
const connection_init = async ({ server, event, message }) => {
    try {
        const payload = await server.onConnectionInit?.({ event, message }) ?? message.payload ?? {};
        if (server.pingpong) {
            await new awsSdk.StepFunctions()
                .startExecution({
                stateMachineArn: server.pingpong.machine,
                name: event.requestContext.connectionId,
                input: JSON.stringify({
                    connectionId: event.requestContext.connectionId,
                    domainName: event.requestContext.domainName,
                    stage: event.requestContext.stage,
                    state: 'PING',
                    choice: 'WAIT',
                    seconds: server.pingpong.delay,
                }),
            })
                .promise();
        }
        // Write to persistence
        await server.models.connection.put({
            id: event.requestContext.connectionId,
            createdAt: Date.now(),
            requestContext: event.requestContext,
            payload,
            hasPonged: false,
            ttl: defaultTTL(),
        });
        return postToConnection(server)({
            ...event.requestContext,
            message: { type: MessageType.ConnectionAck },
        });
    }
    catch (err) {
        await server.onError?.(err, { event, message });
        await deleteConnection(server)(event.requestContext);
    }
};

/** Handler function for 'pong' message. */
const pong = async ({ server, event, message }) => {
    try {
        await server.onPong?.({ event, message });
        await server.models.connection.update({ id: event.requestContext.connectionId }, {
            hasPonged: true,
        });
    }
    catch (err) {
        await server.onError?.(err, { event, message });
        await deleteConnection(server)(event.requestContext);
    }
};

const handleWebSocketEvent = (serverPromise) => async (event) => {
    const server = await serverPromise;
    if (!event.requestContext) {
        server.log('handleWebSocketEvent unknown', { event });
        return {
            statusCode: 200,
            body: '',
        };
    }
    if (event.requestContext.eventType === 'CONNECT') {
        server.log('handleWebSocketEvent CONNECT', { connectionId: event.requestContext.connectionId });
        await server.onConnect?.({ event });
        return {
            statusCode: 200,
            headers: {
                'Sec-WebSocket-Protocol': GRAPHQL_TRANSPORT_WS_PROTOCOL,
            },
            body: '',
        };
    }
    if (event.requestContext.eventType === 'MESSAGE') {
        const message = event.body === null ? null : JSON.parse(event.body);
        server.log('handleWebSocketEvent MESSAGE', { connectionId: event.requestContext.connectionId, type: message.type });
        if (message.type === MessageType.ConnectionInit) {
            await connection_init({ server, event, message });
            return {
                statusCode: 200,
                body: '',
            };
        }
        if (message.type === MessageType.Subscribe) {
            await subscribe$1({ server, event, message });
            return {
                statusCode: 200,
                body: '',
            };
        }
        if (message.type === MessageType.Complete) {
            await complete({ server, event, message });
            return {
                statusCode: 200,
                body: '',
            };
        }
        if (message.type === MessageType.Ping) {
            await ping({ server, event, message });
            return {
                statusCode: 200,
                body: '',
            };
        }
        if (message.type === MessageType.Pong) {
            await pong({ server, event, message });
            return {
                statusCode: 200,
                body: '',
            };
        }
    }
    if (event.requestContext.eventType === 'DISCONNECT') {
        server.log('handleWebSocketEvent DISCONNECT', { connectionId: event.requestContext.connectionId });
        await disconnect({ server, event, message: null });
        return {
            statusCode: 200,
            body: '',
        };
    }
    server.log('handleWebSocketEvent UNKNOWN', { connectionId: event.requestContext.connectionId });
    return {
        statusCode: 200,
        body: '',
    };
};

const handleStepFunctionEvent = (serverPromise) => async (input) => {
    const server = await serverPromise;
    if (!server.pingpong) {
        throw new Error('Invalid pingpong settings');
    }
    // Initial state - send ping message
    if (input.state === 'PING') {
        await postToConnection(server)({ ...input, message: { type: MessageType.Ping } });
        await server.models.connection.update({ id: input.connectionId }, { hasPonged: false });
        return {
            ...input,
            state: 'REVIEW',
            seconds: server.pingpong.delay,
        };
    }
    // Follow up state - check if pong was returned
    const conn = await server.models.connection.get({ id: input.connectionId });
    if (conn?.hasPonged) {
        return {
            ...input,
            state: 'PING',
            seconds: server.pingpong.timeout,
        };
    }
    await deleteConnection(server)({ ...input });
    return {
        ...input,
        state: 'ABORT',
    };
};

const DDB = ({ dynamodb, tableName, log, }) => {
    const documentClient = new awsSdk.DynamoDB.DocumentClient({ service: dynamodb });
    const get = async (Key) => {
        log('get', { tableName: tableName, Key });
        try {
            const { Item } = await documentClient.get({
                TableName: tableName,
                Key,
            }).promise();
            log('get:result', { Item });
            return Item ?? null;
        }
        catch (e) {
            log('get:error', e);
            throw e;
        }
    };
    const put = async (Item, putOptions) => {
        log('put', { tableName: tableName, Item });
        try {
            const { Attributes } = await documentClient.put({
                TableName: tableName,
                Item,
                ReturnValues: 'ALL_OLD',
                ...putOptions,
            }).promise();
            return Attributes;
        }
        catch (e) {
            log('put:error', e);
            throw e;
        }
    };
    const update = async (Key, obj) => {
        log('update', { tableName: tableName, Key, obj });
        try {
            const AttributeUpdates = Object.entries(obj)
                .map(([key, Value]) => ({ [key]: { Value, Action: 'PUT' } }))
                .reduce((memo, val) => ({ ...memo, ...val }));
            const { Attributes } = await documentClient.update({
                TableName: tableName,
                Key,
                AttributeUpdates,
                ReturnValues: 'ALL_NEW',
            }).promise();
            return Attributes;
        }
        catch (e) {
            log('update:error', e);
            throw e;
        }
    };
    const deleteFunction = async (Key) => {
        log('delete', { tableName: tableName, Key });
        try {
            const { Attributes } = await documentClient.delete({
                TableName: tableName,
                Key,
                ReturnValues: 'ALL_OLD',
            }).promise();
            return Attributes;
        }
        catch (e) {
            log('delete:error', e);
            throw e;
        }
    };
    const queryOnce = async (options) => {
        log('queryOnce', { tableName: tableName, options });
        try {
            const response = await documentClient.query({
                TableName: tableName,
                Select: 'ALL_ATTRIBUTES',
                ...options,
            }).promise();
            const { Items, LastEvaluatedKey, Count } = response;
            return {
                items: (Items ?? []),
                lastEvaluatedKey: LastEvaluatedKey,
                count: Count ?? 0,
            };
        }
        catch (e) {
            log('queryOnce:error', e);
            throw e;
        }
    };
    async function* query(options) {
        log('query', { tableName: tableName, options });
        try {
            const results = await queryOnce(options);
            yield* results.items;
            let lastEvaluatedKey = results.lastEvaluatedKey;
            while (lastEvaluatedKey) {
                const results = await queryOnce({ ...options, ExclusiveStartKey: lastEvaluatedKey });
                yield* results.items;
                lastEvaluatedKey = results.lastEvaluatedKey;
            }
        }
        catch (e) {
            log('query:error', e);
            throw e;
        }
    }
    return {
        get,
        put,
        update,
        query,
        delete: deleteFunction,
    };
};

const logger = debug('graphql-lambda-subscriptions');
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
const log = (message, obj) => logger(`${message} %j`, obj);

const buildServerClosure = async (opts) => {
    const { tableNames, log: log$1 = log, dynamodb: dynamodbPromise, apiGatewayManagementApi, pingpong, ...rest } = opts;
    const dynamodb = await dynamodbPromise;
    return {
        ...rest,
        apiGatewayManagementApi: await apiGatewayManagementApi,
        pingpong: await pingpong,
        dynamodb: dynamodb,
        log: log$1,
        models: {
            subscription: DDB({ dynamodb, tableName: (await tableNames)?.subscriptions || 'graphql_subscriptions', log: log$1 }),
            connection: DDB({ dynamodb, tableName: (await tableNames)?.connections || 'graphql_connections', log: log$1 }),
        },
    };
};

/**
 * Creates subscribe handler for use in your graphql schema.
 *
 * `subscribe` is the most important method in the library. It is the primary difference between `graphql-ws` and `graphql-lambda-subscriptions`. It returns a {@link SubscribePseudoIterable} that pretends to be an async iterator that you put on the `subscribe` resolver for your Subscription. In reality it includes a few properties that we use to subscribe to events and fire lifecycle functions. See {@link SubscribeOptions} for information about the callbacks.
 *
 * @param topic - Subscriptions are made to a `string` topic and can be filtered based upon the topics payload.
 * @param options - Optional callbacks for filtering, and lifecycle events.
 */
const subscribe = (topic, options = {}) => {
    const { filter, onSubscribe, onComplete, onAfterSubscribe, } = options;
    const handler = createHandler();
    handler.topic = topic;
    handler.filter = filter;
    handler.onSubscribe = onSubscribe;
    handler.onComplete = onComplete;
    handler.onAfterSubscribe = onAfterSubscribe;
    return handler;
};
const createHandler = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any,require-yield
    const handler = async function* () {
        throw new Error('Subscription handler should not have been called');
    };
    return handler;
};

const makeServer = (opts) => {
    const closure = buildServerClosure(opts);
    return {
        webSocketHandler: handleWebSocketEvent(closure),
        stepFunctionsHandler: handleStepFunctionEvent(closure),
        publish: publish(closure),
        complete: complete$1(closure),
    };
};

exports.makeServer = makeServer;
exports.subscribe = subscribe;
